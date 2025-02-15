import { ImportMap } from '@jspm/import-map';
import babel from '@babel/core';
import dewTransformPlugin from 'babel-plugin-transform-cjs-dew';
import path from 'path';
import { Generator, fetch } from '@jspm/generator';

// TODO:
// - ImportMap resolve to support env
// - Generator to support outputting conditional import maps
// - 

let cache = Object.create(null);

const FORMAT_ESM = undefined;
const FORMAT_CJS = 1;
const FORMAT_CJS_DEW = 2;
const FORMAT_JSON = 4;
const FORMAT_TYPESCRIPT = 8;

export default ({ baseUrl, defaultProvider = 'nodemodules', env = ['browser', 'development'], minify, externals, inputMap } = {}) => {
  if (baseUrl) {
    if (typeof baseUrl === 'string')
      baseUrl = new URL(baseUrl);
  }
  else {
    if (typeof Deno !== 'undefined') {
      baseUrl = new URL('file://' + Deno.cwd() + '/');
    }
    else if (typeof process !== 'undefined' && process.versions.node) {
      baseUrl = new URL('file://' + process.cwd() + '/');
    }
    else if (typeof document !== 'undefined') {
      const baseEl = document.querySelector('base[href]');
      if (baseEl)
        baseUrl = new URL(baseEl.href + (baseEl.href.endsWith('/') ? '' : '/'));
      else if (typeof location !== 'undefined')
        baseUrl = new URL('../', new URL(location.href));
    }
  }

  if (externals instanceof Array) {
    const _externals = {};
    for (const ext of externals)
      _externals[ext] = true;
    externals = _externals;
  }

  let terser, generator, importMap, moduleFormats, externalsMap,
    bufferBuiltinResolved, moduleBuiltinResolved, processBuiltinResolved, builtinResolvedErr;

  return {
    name: '@jspm/plugin-rollup',
    options (opts) {
      opts.output = opts.output || {};
      opts.output.interop = false;

      // Always convert the input into object form
      let input;
      if (Array.isArray(opts.input)) {
        const seen = {};
        input = Object.fromEntries(opts.input.map(m => {
          let n = m.split('/').pop();
          const extIndex = n.lastIndexOf('.');
          if (extIndex !== -1)
            n = n.slice(0, extIndex);
          if (seen[n]) {
            const _n = n;
            let i = 1;
            while (seen[n])
              n = _n + ++i;
          }
          seen[n] = true;
          return [n, m];
        }));
      }
      else {
        input = opts.input;
      }
      opts.input = input;

      return opts;
    },
    get logStream () {
      return generator.logStream;
    },
    async buildStart (opts) {
      moduleFormats = new Map();
      cache = Object.create(null);

      // run the generator phase _first_
      generator = new Generator({ mapUrl: baseUrl, env, defaultProvider, inputMap });

      // (async () => {
      //   for await (const { type, message } of generator.logStream()) {
      //     console.log(`${type}: ${message}`);
      //   }
      // })();
      
      if (minify && !terser)
        terser = await import('terser');

      // always trace process and buffer builtins
      try {
        await Promise.all([generator.traceInstall('process'), generator.traceInstall('buffer'), generator.traceInstall('module')]);
        processBuiltinResolved = generator.importMap.resolve('process');
        bufferBuiltinResolved = generator.importMap.resolve('buffer');
        moduleBuiltinResolved = generator.importMap.resolve('module');
      }
      catch (err) {
        builtinResolvedErr = err;
      }

      await Promise.all(Object.values(opts.input).map(async specifier => {
        await generator.traceInstall(specifier, baseUrl);
      }));

      // Pending next Generator update
      importMap = new ImportMap(generator.importMap.baseUrl, generator.importMap.toJSON());

      if (externals) {
        externalsMap = new Map();
        // resolve externals to populate externalsMap
        // TODO: support scoped externals
        await Promise.all(Object.entries(externals).map(async ([name, alias]) => {
          const resolved = importMap.resolve(name, baseUrl, { cache, env, browserBuiltins });
          if (resolved !== null)
            externalsMap.set(resolved, alias);
        }));
      }
    },
    async resolveId (name, parent) {
      const topLevel = !parent;
      if (topLevel)
        parent = baseUrl;

      const cjsResolve = moduleFormats.get(parent) & (FORMAT_CJS | FORMAT_CJS_DEW);

      if (cjsResolve && name[name.length - 1] === '/')
        name = name.substr(0, name.length - 1);

      let resolved = importMap.resolve(name, parent);

      if (!resolved)
        throw new Error('Module not found: ' + name + ' in ' + parent);

      if (resolved.endsWith('/'))
        throw new Error('Trailing slash resolution for ' + name + ' in ' + parent);
      if (resolved.endsWith('.'))
        throw new Error('Trailing dot resolution for ' + name + ' in ' + parent);

      if (resolved === null) {
        // non top-level not found treated as externals, but with a warning
        // if (err.code === 'MODULE_NOT_FOUND' && !topLevel && !name.startsWith('./') && !name.startsWith('../')) {
        //   console.warn(`jspm could not find ${name} from ${parent}, treating as external.`);
        //   return false;
        // }
        throw new Error('Module not found: ' + name + ' imported from ' + parent);
      }

      const format = generator.getAnalysis(resolved).format;

      if (resolved.startsWith('node:'))
        return { id: resolved.slice(5), external: true };

      // builtins treated as externals
      // (builtins only emitted as builtins from resolver for Node, not browser)
      switch (format) {
        case 'json':
          moduleFormats.set(resolved, FORMAT_JSON);
        break;
        case 'commonjs':
          if (!cjsResolve)
            resolved += '?entry';
          moduleFormats.set(resolved, cjsResolve ? FORMAT_CJS_DEW : FORMAT_CJS);
        break;
        case 'typescript':
          moduleFormats.set(resolved, FORMAT_TYPESCRIPT);
        break;
      }

      if (externalsMap) {
        let id = externalsMap.get(resolved);
        if (id !== undefined) {
          if (id === true)
            id = name;
          return { id, external: true };
        }
      }

      return resolved;
    },
    async load (id) {
      if (id.endsWith('?entry'))
        return `import { dew } from "./${path.basename(id.substr(0, id.length - 6))}";\nexport default dew();`;
      return (await fetch(id)).text();
    },
    transform (code, id) {
      switch (moduleFormats.get(id)) {
        case FORMAT_ESM:
          return { code, map: null };
        case FORMAT_JSON:
          return { code: 'export default ' + code, map: null };
        case FORMAT_CJS:
          return { code, map: null };
        case FORMAT_TYPESCRIPT:
          return babel.transform(code, {
            filename: id,
            babelrc: false,
            highlightCode: false,
            compact: false,
            sourceType: 'module',
            sourceMaps: true,
            parserOpts: {
              allowReturnOutsideFunction: true,
              // plugins: stage3Syntax
            },
            presets: ['@babel/preset-typescript']
          });
        case FORMAT_CJS_DEW:
          // fallthrough
        break;
        default:
          throw new Error('Unexpected format');
      }

      // FORMAT_CJS_DEW
      return babel.transform(code, {
        filename: id,
        babelrc: false,
        highlightCode: false,
        compact: false,
        sourceType: 'script',
        sourceMaps: true,
        parserOpts: {
          allowReturnOutsideFunction: true,
          // plugins: stage3Syntax
        },
        plugins: [[dewTransformPlugin, {
          browserOnly: 'browser' in env,
          define: {
            'process.env.NODE_ENV': 'production' in env ? '"production"' : '"dev"'
          },
          resolve: (depId, opts) => {
            // CommonJS always gets trailing "/" stripped
            // Specifics of these resolution differences handled as best as possible in generator
            // Although packages using both / and non-/ forms have ambiguity
            if (depId.endsWith('/../') || depId === '../') {
              if (!(depId.startsWith('/') || depId.startsWith('./') || depId.startsWith('../')))
                throw new Error('Unable to resolve ' + depId + ' in ' + id + ' as the final segment mapping is unknown.');
              const resolved = new URL(depId, id).href;
              const lastSegmentIndex = resolved.lastIndexOf('/', resolved.length - 2);
              const lastSegment = resolved.slice(lastSegmentIndex, -1);
              depId += '..' + lastSegment;
            }
            else if (depId.endsWith('/')) {
              depId = depId.slice(0, -1);
            }

            if (depId === 'process') {
              if (builtinResolvedErr)
                throw builtinResolvedErr;
              return processBuiltinResolved;
            }
            if (depId === 'buffer') {
              if (builtinResolvedErr)
                throw builtinResolvedErr;
              return bufferBuiltinResolved;
            }
            if (depId === 'module') {
              if (builtinResolvedErr)
                throw builtinResolvedErr;
              return moduleBuiltinResolved;
            }

            if (opts.optional) {
              const resolved = importMap.resolve(depId, id);
              if (!resolved)
                throw new Error('Could not resolve optional ' + resolved + ' in ' + id);
              return depId;
            }

            if (opts.wildcard) {
              // we can only wildcard resolve internal requires
              if (!depId.startsWith('./') && !depId.startsWith('../'))
                return;
              const glob = new URL(depId, id);
              throw new Error(`TODO: CJS wildcard: ${glob}`);
              //const wildcardPath = path.relative(pkgBasePath, path.resolve(filePath.substr(0, filePath.lastIndexOf(path.sep)), pattern)).replace(/\\/g, '/');
              //const wildcardPattern = new RegExp('^' + wildcardPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
              /*const matches = Object.keys(files).filter(file => file.match(wildcardPattern) && (file.endsWith('.js') || file.endsWith('.json') || file.endsWith('.node')));
              const relFile = path.relative(pkgBasePath, path.resolve(filePath.substr(0, filePath.lastIndexOf(path.sep))));
              return matches.map(match => {
                let relPath = path.relative(relFile, match).replace(/\\/g, '/');
                if (relPath === '')
                  relPath = './' + filePath.substr(filePath.lastIndexOf('/') + 1);
                else if (!relPath.startsWith('../'))
                  relPath = './' + relPath;
                return relPath;
              });*/
            }

            return depId;
          },
          wildcardExtensions: ['.js', '.json', '.node'],
          // externals are ESM dependencies
          esmDependencies: depId => {
            if (depId.endsWith('/../') || depId === '../') {
              if (!(depId.startsWith('/') || depId.startsWith('./') || depId.startsWith('../')))
                throw new Error('Unable to resolve ' + depId + ' in ' + id + ' as the final segment mapping is unknown.');
              const resolved = new URL(depId, id).href;
              const lastSegmentIndex = resolved.lastIndexOf('/', resolved.length - 2);
              const lastSegment = resolved.slice(lastSegmentIndex, -1);
              depId += '..' + lastSegment;
            }
            else if (depId.endsWith('/')) {
              depId = depId.slice(0, -1);
            }
            if (depId === 'buffer' || depId === 'module' || depId === 'process')
              return true;
            const resolved = importMap.resolve(depId, id);
            if (!resolved)
              throw new Error('Could not resolve ' + depId + ' in ' + id);
            const { format } = generator.getAnalysis(resolved);
            // TODO: externals = 'namespace-interop'
            return format === 'esm' || format === 'json' ? true : false;
          },
          filename: `import.meta.url.startsWith('file:') ? decodeURI(import.meta.url.slice(7 + (typeof process !== 'undefined' && process.platform === 'win32'))) : new URL(import.meta.url).pathname`,
          dirname: `import.meta.url.startsWith('file:') ? decodeURI(import.meta.url.slice(0, import.meta.url.lastIndexOf('/')).slice(7 + (typeof process !== 'undefined' && process.platform === 'win32'))) : new URL(import.meta.url.slice(0, import.meta.url.lastIndexOf('/'))).pathname`
        }]]
      });
    },
    async renderChunk (code, _chunk, outputOptions) {
      if (!minify) return;
      try {
        var result = await terser.minify(code, {
          sourceMap: {
            asObject: true,
          },
          module: true,
          toplevel: true,
          // defaults to mangle and compress
          keep_fnames: true,
          keep_classnames: true,
          compress: {
            defaults: false,

            // collapse_vars triples terser time...
            // collapse_vars: true,
            computed_props: true,
            conditionals: true,
            dead_code: true,
            directives: true,
            // switches: true,
            if_return: true,
            properties: true,

            side_effects: false,
            keep_fargs: true,
            keep_infinity: true,
            
            unused: true,
            evaluate: true
          },
          output: {
            comments: function(_node, comment) {
              // multiline comment
              if (comment.type == "comment2")
                return /@(preserve|license|cc_on|param|returns|typedef|template|type|deprecated)/i.test(comment.value);
            }
          }
        });
      }
      catch (e) {
        // Always skip Terser bugs
        this.warn({
          message: `Terser error during build, skipping minification of chunk.\n${result.error}`,
          originalError: result.error
        });
        return;
      }

      if (result.error) {
        // Always skip Terser bugs
        this.warn({
          message: `Terser error during build, skipping minification of chunk.\n${result.error}`,
          originalError: result.error
        });
        return;
      }

      return result;
    }
  };
};

// Copyright & License details are available under JXCORE_LICENSE file

var NativeModule = require('native_module');
var Script = process.binding('evals').NodeScript;
var runInThisContext = Script.runInThisContext;
var runInNewContext = Script.runInNewContext;
var assert = require('assert').ok;
var path = NativeModule.require('path');
var $uw = process.binding('memory_wrap');
var fs = NativeModule.require('fs');
var util = NativeModule.require('util');

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function Module(id, parent) {
  this.id = id;
  this.exports = {};
  this.parent = parent;
  if (parent && parent.children) {
    parent.children.push(this);
  }

  this.filename = null;
  this.loaded = false;
  this.children = [];
}
module.exports = Module;

// Set the environ variable NODE_MODULE_CONTEXTS=1 to make node load all
// modules in their own context.
Module._contextLoad = (+process.env['NODE_MODULE_CONTEXTS'] > 0);
Module._cache = {};
Module._pathCache = {};
Module._extensions = {};
var modulePaths = [];
Module.globalPaths = [];

Module.wrapper = NativeModule.wrapper;
Module.wrap = NativeModule.wrap;

Module._debug = function() {
};

if (process.env.NODE_DEBUG && /module/.test(process.env.NODE_DEBUG)) {
  Module._debug = console.error;
}


// We use this alias for the preprocessor that filters it out
var debug = Module._debug;


// given a module name, and a list of paths to test, returns the first
// matching file in the following precedence.

// require("a.<ext>")
// -> a.<ext>

// require("a")
// -> a
// -> a.<ext>
// -> a/index.<ext>

function statPath(path) {
  try {
    return fs.statSync(path);
  } catch (ex) {
  }
  return false;
}

function isThreadLoadingRoots() {
  return (!process.subThread && process.threadId == -1) ||
    (process._MTED && process.threadId == 0);
}

var __existsSync = function(_path) {  // checks the file system

  try {
    var long = path._makeLong(_path);
  } catch (e) {
    console.error('module::__existsSync', e);
    return false;
  }

  try {
    process.binding('fs').stat(long);
    return true;
  } catch (e) {
    return false;
  }
};

var __mkdirSync = function(dir) {

  if (__existsSync(dir))
    return true;

  // enabling extension for recursive creation may be necessary
  var cmd = process.platform === 'win32' ? 'cmd /E:ON /C mkdir ' : 'mkdir -p ';
  cmd += '"' + dir + '"';

  var ret = jxcore.utils.cmdSync(cmd);
  if (ret.exitCode) {
    jxcore.utils.console.error('Cannot create directory:', dir);
    jxcore.utils.console.log(ret.out);
    try {
      process.exit();
    } catch (e) {
    }
  } else {
    return true;
  }
};

var findJXInPath = function() {

  var ret = jxcore.utils.cmdSync(process.platform === 'win32' ?
      'where jx' : 'which jx');

  if (ret.exitCode || !ret.out)
    return null;

  var os = NativeModule.require('os');
  var arr = ret.out.split(os.EOL);
  var _path = arr[0];
  if (!fs.existsSync(_path))
    return null;

  var ret = jxcore.utils.cmdSync(_path +
                                 ' -p "JSON.stringify(process.versions)"');
  try {
    var versions = JSON.parse(ret.out);
    if (versions.jxcore)
      return _path;
  } catch (ex) {
  }
  return null;
};

// check if the directory is a package.json dir
var packageMainCache = {};

function readPackage(requestPath) {
  if (hasOwnProperty(packageMainCache, requestPath)) {
    return packageMainCache[requestPath];
  }

  try {
    var jsonPath = path.resolve(requestPath, 'package.json');
    var json = fs.readFileSync(jsonPath, 'utf8');
  } catch (e) {
    return false;
  }

  try {
    var pkg = packageMainCache[requestPath] = JSON.parse(json).main;
  } catch (e) {
    e.path = jsonPath;
    e.message = 'Error parsing ' + jsonPath + ': ' + e.message;
    throw e;
  }
  return pkg;
}

function tryPackage(requestPath, exts) {
  var pkg = readPackage(requestPath);

  if (!pkg) return false;

  var filename = path.resolve(requestPath, pkg);
  return tryFile(filename) || tryExtensions(filename, exts) ||
         tryExtensions(path.resolve(filename, 'index'), exts);
}

// In order to minimize unnecessary lstat() calls,
// this cache is a list of known-real paths.
// Set to an empty object to reset.
Module._realpathCache = {};

// check if the file exists and is not a directory
function tryFile(requestPath) {
  var stats = statPath(requestPath);
  if (stats && !stats.isDirectory()) {
    debug('Module.tryFile >', requestPath);
    return fs.realpathSync(requestPath, Module._realpathCache);
  }
  return false;
}

// given a path checks if the file exists with any of the set extensions
function tryExtensions(p, exts) {
  for (var i = 0, EL = exts.length; i < EL; i++) {
    var filename = tryFile(p + exts[i]);

    if (filename) {
      return filename;
    }
  }
  return false;
}


Module._findPath = function(request, paths) {
  var exts = Object.keys(Module._extensions);

  if (request.charAt(0) === '/') {
    paths = [''];
  }

  var trailingSlash = (request.slice(-1) === '/');

  var cacheKey = JSON.stringify({request: request, paths: paths});
  if (Module._pathCache[cacheKey]) {
    return Module._pathCache[cacheKey];
  }

  // For each path
  for (var i = 0, PL = paths.length; i < PL; i++) {
    var basePath = path.resolve(paths[i], request);
    var filename;

    if (!trailingSlash) {
      // try to join the request to the path
      filename = tryFile(basePath);

      if (!filename && !trailingSlash) {
        // try it with each of the extensions
        filename = tryExtensions(basePath, exts);
      }
    }

    if (!filename) {
      filename = tryPackage(basePath, exts);
    }

    if (!filename) {
      // try it with each of the extensions at "index"
      filename = tryExtensions(path.resolve(basePath, 'index'), exts);
    }

    if (filename) {
      Module._pathCache[cacheKey] = filename;
      return filename;
    }
  }

  return false;
};

// 'from' is the __dirname of the module.
Module._nodeModulePaths = function(from) {
  // guarantee that 'from' is absolute.
  from = path.resolve(from);

  // note: this approach *only* works when the path is guaranteed
  // to be absolute. Doing a fully-edge-case-correct path.split
  // that works on both Windows and Posix is non-trivial.
  var splitRe = process.platform === 'win32' ? /[\/\\]/ : /\//;

  var paths = [];
  var parts = from.split(splitRe);

  for (var tip = parts.length - 1; tip >= 0; tip--) {
    // don't search in .../node_modules/node_modules
    if (parts[tip] === 'node_modules') continue;
    var dir = parts.slice(0, tip + 1).concat('node_modules').join(path.sep);
    paths.push(dir);
  }

  return paths;
};


Module._resolveLookupPaths = function(request, parent) {
  if (NativeModule.exists(request)) {
    return [request, []];
  }

  var start = request.substring(0, 2);
  if (start !== '.' && start !== './' && start !== '..') {
    var paths = modulePaths;
    if (parent) {
      if (!parent.paths) parent.paths = [];
      if (isWinRT) {
        // realpathSync works limited.
        // walk back
        var rp = path.dirname(parent.filename);
        if (parent.parent && parent.parent.paths) {
          for (var i=0;i<parent.parent.paths.length;i++)
            if (parent.paths.indexOf(parent.parent.paths[i]) == -1)
              parent.paths.unshift(parent.parent.paths[i]);
        }

        var check = 'node_modules\\';
        var checkln = check.length;
        var upln = process.userPath.length;
        while(rp.length > upln && rp.substr(rp.length-checkln, checkln) != check) {
          var chck = path.join(rp, 'node_modules');
          if (fs.existsSync(chck))
            if (parent.paths.indexOf(chck) == -1)
              parent.paths.unshift(chck);
          rp = path.join(rp, '../');
        }
      }
      paths = parent.paths.concat(paths);
    }
    return [request, paths];
  }

  // with --eval, parent.id is not set and parent.filename is null
  if (!parent || !parent.id || !parent.filename) {
    // make require('./path/to/foo') work - normally the path is taken
    // from realpath(__filename) but with eval there is no filename
    var mainPaths = ['.'].concat(modulePaths);
    mainPaths = Module._nodeModulePaths('.').concat(mainPaths);
    return [request, mainPaths];
  }

  // Is the parent an index module?
  // We can assume the parent has a valid extension,
  // as it already has been accepted as a module.
  var isIndex = /^index\.\w+?$/.test(path.basename(parent.filename));
  var parentIdPath = isIndex ? parent.id : path.dirname(parent.id);
  var id = path.resolve(parentIdPath, request);

  // make sure require('./path') and require('path') get distinct ids, even
  // when called from the toplevel js file
  if (parentIdPath === '.' && id.indexOf('/') === -1) {
    id = './' + id;
  }

  debug('RELATIVE: requested:', request,
        'set ID to:', id, 'from', parent.id);

  return [id, [path.dirname(parent.filename)]];
};

var native_starters = {
  '_jx_subs': 'SubThread',
  '_jx_multiplier': 'MTED',
  '_jx_monitorHelper': 'Monitoring',
  '_jx_source': 'Source'
};

Module._load = function(request, parent, isMain, content, forced) {
  if (parent) {
    debug('Module._load REQUEST', request, 'parent:', parent.id);
  }

  var filename;

  if (!content) {
    if (native_starters.hasOwnProperty(request) || process.entry_file_name_)
      filename = request;
    else {
      filename = Module._resolveFilename(request, parent);
    }
  } else {
    filename = request;
  }

  var cachedModule = Module._cache[filename];
  if (cachedModule) {
    return cachedModule.exports;
  }

  var sources = null;
  if (content) {
    sources = content;
  }
  else if (native_starters.hasOwnProperty(filename)) {
    debug('starter native module', native_starters[filename]);
    sources = NativeModule.getSource(filename);
  }
  else if (filename !== 'main.js' && NativeModule.exists(filename)) {
    // REPL is a special case, because it needs the real require.
    if (filename == 'repl') {
      var replModule = new Module('repl');
      replModule._compile(NativeModule.getSource('repl'), 'repl.js');
      NativeModule._cache.repl = replModule;
      return replModule.exports;
    }

    debug('load native module', request);
    return NativeModule.require(filename);
  }

  var module = new Module(filename, parent);
  module.fileSource = sources;

  if (isMain) {
    process.mainModule = module;
    module.id = '.';
  }

  Module._cache[filename] = module;

  var hadException = true;

  try {
    module.load(filename, parent, forced);
    hadException = false;
  } finally {
    if (hadException) {
      delete Module._cache[filename];
    }
  }

  return module.exports;
};


Module.prototype.load = function(filename, parent, force) {
  debug('load', filename, 'for module', this.id);

  assert(!this.loaded);
  this.filename = filename;

  if (!this.fileSource ||
      (process._EmbeddedSource && filename == 'jx_source.jx')) {
    this.paths = Module._nodeModulePaths(path.dirname(filename));

    var extension = path.extname(filename) || '.js';

    if (!Module._extensions[extension])
      extension = '.js';

    if (process.subThread && parent &&
        (filename == parent.filename ||
         filename == parent.filename.substr(0,
             parent.filename.length - 5) + 'jx') &&
        filename == process.mainModule.filename) {
      Module._extensions[extension](this, filename, null);
    }
    else {
      Module._extensions[extension](this, filename, parent);
    }
  } else {
    var checkAgain = process.subThread && (!process.mainModule.filename ||
        process.mainModule.filename === '_jx_subs' ||
        process.mainModule.filename.indexOf('NodeJXThread') !== -1);

    this.paths = Module._nodeModulePaths(process.cwd());
    if (!force)
      this._compile(stripBOM(this.fileSource), filename, false, false);
    else
      this._compile(stripBOM(this.fileSource), filename, true, true);

    // additional paths resolving for tasks as method() and logic()
    // possible since process.mainModule.filename is known now due to _compile()
    if (checkAgain && process.mainModule.filename !== filename) {
      var arr = Module._nodeModulePaths(
          path.dirname(process.mainModule.filename));

      // iterating from the end, injecting lacking paths to the beginning
      for (var a = arr.length - 1; a >= 0; a--) {
        if (this.paths.indexOf(arr[a]) === -1)
          this.paths.unshift(arr[a]);
      }
    }
  }

  this.loaded = true;
};


Module.prototype.require = function(path, a, b, c, content) {
  assert(typeof path === 'string', 'path must be a string');
  assert(path, 'missing path');

  return Module._load(path, this, c, content, b);
};


// Resolved path to process.argv[1] will be lazily placed here
// (needed for setting breakpoint when called with --debug-brk)
var resolvedArgv;

// Returns exception if any
Module.prototype._compile = function(content, filename, cached, _jxed) {
  var self = this;

  var extname = path.extname(filename).toLowerCase();
  if (!cached || extname == '.js') {
    content = content.replace(/^\#\!.*/, '');
  }

  function require(path, a, b, c, content) {
    return self.require(path, a, b, c, content, false);
  }

  require.resolve = function(request) {
    var fn = Module._resolveFilename(request, self);
    if (fn) {
      fn = fn.trim();
      if (fn.toLowerCase().indexOf('.js.jx') == fn.length - 6)
        fn = fn.substr(0, fn.length - 3);
    }
    return fn;
  };

  Object.defineProperty(require, 'paths', { get: function() {
    throw new Error('require.paths is removed. Use ' +
                    'node_modules folders, or the NODE_PATH ' +
                    'environment variable instead.');
  }});

  require.main = process.mainModule;

  // Enable support to add extra extension types
  require.extensions = Module._extensions;
  require.registerExtension = function() {
    throw new Error('require.registerExtension() removed. Use ' +
                    'require.extensions instead.');
  };

  require.cache = Module._cache;

  var dirname;
  if (!_jxed && content && content.length) {
    if (content.charAt(0) == '@') {
      _jxed = true;
    }
  }

  if (filename == '_jx_subs' || filename == '_monitor_helper' ||
      process.entry_file_name_) {
    dirname = process.cwd();
  } else if (filename == 'jx_source.jx' || filename == '_jx_source') {
    dirname = path.dirname(process.execPath);
  } else if (_jxed) {
    dirname = path.dirname(content.substr(1));
    if (dirname && dirname.length) {
      if (dirname.charAt(0) == '.') {
        dirname = dirname.substr(1);
      }
      filename = filename.replace(dirname, '');
      filename = path.join(dirname, filename);
    }
  } else {
    dirname = path.dirname(filename);
  }

  if (isWindows) {
    if (dirname && dirname.length > 2) {
      if (dirname.charAt(0) == '.' && dirname.charAt(1) == '\\') {
        dirname = dirname.substr(2);
      }
    }
  }

  if (Module._contextLoad) {
    if (self.id !== '.') {
      debug('load submodule');
      // not root module
      var sandbox = {};
      for (var k in global) {
        if (global.hasOwnProperty(k))
          sandbox[k] = global[k];
      }
      sandbox.require = require;
      sandbox.exports = self.exports;
      sandbox.__filename = filename;
      sandbox.__dirname = dirname;
      sandbox.module = self;
      sandbox.global = sandbox;
      sandbox.root = root;

      return runInNewContext((cached) ? _xo(content) :
                                 content, sandbox, filename, true);
    }

    debug('load root module');
    // root module
    global.require = require;
    global.exports = self.exports;
    global.__filename = filename;
    global.__dirname = dirname;
    global.module = self;

    return runInThisContext((cached) ? _xo(content) : content, filename, true);
  }

  var wrapper = Module.wrap((cached) ? _xo(content) : content);
  var compiledWrapper = runInThisContext(wrapper, filename, true);
  if (global.v8debug && !process.subThread) {
    if (!resolvedArgv) {
      // we enter the repl if we're not given a filename argument.
      if (process.argv[1]) {
        if (process._MTED) {
          resolvedArgv = Module._resolveFilename(process.argv[2], null);
        }
        else
          resolvedArgv = Module._resolveFilename(process.argv[1], null);
      } else {
        resolvedArgv = 'repl';
      }
    }

    // Set breakpoint on module start
    if (filename === resolvedArgv) {
      global.v8debug.Debug.setBreakPoint(compiledWrapper, 0, 0);
    }
  }

  // TODO(obastemur) check ION again and remove the below hack or fix it.
  // -- I personally suspect ION skips it mostly because of multiple references
  //    to globals?
  //
  // experimental hack
  // ionSpew may skip ION compilation when there is a global member used.
  // sending the popular references: setTimeout, setInterval, and process
  var args = [self.exports, require, self, filename, dirname,
              global.setTimeout, global.setInterval, global.process];
  return compiledWrapper.apply(self.exports, args);
};


function stripBOM(content) {
  // Remove byte order marker. This catches EF BB BF (the UTF-8 BOM)
  // because the buffer-to-string conversion in `fs.readFileSync()`
  // translates it to FEFF, the UTF-16 BOM.
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  return content;
}


// Native extension for .js
Module._extensions['.js'] = function(module, filename, _) {
  var content;
  if (!process.entry_file_name_)
  {
    content = fs.readFileSync(filename, 'utf8');
  } else {
    filename = path.basename(filename);
    if (!$uw.existsSource(filename)) {
      throw new Error("Entry filename wasn't exist (" + filename + ')');
    }
    content = $uw.readSource(filename, true).toString();
    delete process.entry_file_name_;
  }

  module._compile(stripBOM(content), filename, undefined, undefined);

  if (process.entry_file_name_) {
    process.entry_file_name_ = null;
    delete process.entry_file_name_;
  }
};


// Native extension for .json
Module._extensions['.json'] = function(module, filename) {
  var content = fs.readFileSync(filename, 'utf8');
  try {
    module.exports = JSON.parse(stripBOM(content));
  } catch (err) {
    err.message = filename + ': ' + err.message;
    throw err;
  }
};


// Native extension for .node
Module._extensions['.node'] = process.dlopen;

var isWinRT = process.platform === 'winrt';
var isWindows = process.platform === 'win32' || isWinRT;
var isMobile = process.platform === 'ios' || process.platform === 'android';
isMobile = isMobile && process.isEmbedded;

Module._initPaths = function() {
  var homeDir;
  if (!isWinRT && isWindows) {
    homeDir = process.env.USERPROFILE;
  } else if (isWinRT || isMobile) {
    modulePaths = [];
    modulePaths[0] = process.userPath;
    modulePaths[1] = process.cwd();
    modulePaths[2] = path.join(process.cwd(), 'jxcore');
    if (isWinRT)
      modulePaths[3] = path.join(process.userPath, 'Assets');
    Module.globalPaths = modulePaths.slice(0);
    return;
  } else {
    homeDir = process.env.HOME;
  }

  var paths = [];
  paths[0] = path.resolve(process.execPath, '..', '..', 'lib', 'node');

  if (process.env['NODE_PATH']) {
    var splitter = isWindows ? ';' : ':';
    var arr = process.env['NODE_PATH'].split(splitter);
    var arr_c = [];
    if (isWindows) {
      for (var o in arr) {
        if (!arr.hasOwnProperty(o)) continue;
        if (arr[o] && arr[o].length > 3) {
          var ch = arr[o];
          if (ch[2] == '\\' && ch[0] == ch[0].toLowerCase()) {
            arr_c.push(ch[0].toUpperCase() + ch.substr(1, ch.length - 1));
          }
          else {
            arr_c.push(ch[1].toLowerCase() + ch.substr(1, ch.length - 1));
          }
        }
      }
      arr = arr.concat(arr_c);
    }

    paths = arr.concat(paths);
  }

  if (homeDir) {
    paths.unshift(path.resolve(homeDir, '.node_libraries'));
    paths.unshift(path.resolve(homeDir, '.node_modules'));
    paths.unshift(path.resolve(homeDir, 'jxmodules'));
  }

  modulePaths = paths;

  // clone as a read-only copy, for introspection.
  Module.globalPaths = modulePaths.slice(0);
};

Module.addGlobalPath = function(path) {
  if (path && path.length) {
    modulePaths.unshift(path);
  }
  Module.globalPaths = modulePaths.slice(0);
};

Module.removeGlobalPath = function(path) {
  if (path && path.length) {
    var arr = [];
    for (var i in modulePaths) {
      if (modulePaths.hasOwnProperty(i) && modulePaths[i] != path) {
        arr.push(modulePaths[i]);
      }
    }
    modulePaths = arr.slice(0);
    Module.globalPaths = modulePaths.slice(0);
  }
};

// bootstrap repl
Module.requireRepl = function() {
  return Module._load('repl', '.');
};

Module._initPaths();

// backwards compatibility
Module.Module = Module;

var _dirname = function(o) {
  if (o && o.trim && o.length) {
    var p = o.trim();
    if (p[p.length - 1] == path.sep) {
      return p.substr(0, p.length - 1);
    }
  }
  return null;
};

Module.nameFix = function(a) {
  var repFrom = isWindows ? /[\/]/g : /[\\]/g;
  var repTo = isWindows ? '\\' : '/';
  return a.replace(repFrom, repTo);
};

Module._oldRes = function(request, parent) {
  var resolvedModule = Module._resolveLookupPaths(request, parent);
  var id = resolvedModule[0];
  var paths = resolvedModule[1];

  // look up the filename first, since that's the cache key.

  debug('looking for', id, 'in', paths);

  var filename = Module._findPath(request, paths);

  // additional paths resolving for define()
  // logic() and method() were resolved properly in _nodeModulePaths()
  if (!filename &&
      (process.subThread || process.isPackaged) &&
      parent && parent.parent && parent.parent.filename) {
    var p = Module._nodeModulePaths(parent.parent.filename);
    filename = Module._findPath(request, p);
  }

  if (!filename) {
    var err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return filename;
};

Module._resolveFilename = Module._oldRes;
var _xo = function(c) {
  return c;
};

var getMemContent = function(content) {
  return content;
};

// bootstrap main module.
Module.runMain = function() {
  // Load the main module--the command line argument.
  Module._load(process.argv[1], null, true);
  // Handle any nextTicks added in the first tick of the program
  process._tickCallback();
};


/** JXCORE_JXP* */
var jxt = process.binding('jxutils_wrap');

/**
 * Allows to override the path for node-gyp.js
 * if process.env.JX_NODE_GYP_OVERRIDE is present.
 * This is used by npmjx.
 */
var nodeGypOverride = function(_path, sid) {

  if (process.env.JX_NODE_GYP_OVERRIDE) {
    var newPath = process.env.JX_NODE_GYP_OVERRIDE;
    if (path.resolve(_path) === path.resolve(newPath))
      return false;

    var bn = path.basename(_path.toLowerCase());
    if (bn === 'node-gyp' || bn === 'node-gyp.js' && fs.existsSync(newPath)) {
      if (process.env.JX_NODE_GYP_OVERRIDE_VERBOSE) {
        jxcore.utils.console.info('Overriding node-gyp.js at %s:\n  old: %s\n  new:%s',
          sid, path.resolve(_path), newPath);
      }

      return newPath;
    }
  }
  return false;
};

Module.runMain = function() {
  if (process.subThread) {
    var isJXPackaged = null;
    if (!process.isPackaged && !process.isEmbedded) {
      var jxmain = process.argv[process._MTED ? 2 : 1];
      if (jxmain) jxmain = jxmain.trim();
      isJXPackaged = jxmain && jxmain.length > 3 && jxmain.slice(-3).toLowerCase() === '.jx';
    }
    if (process.isPackaged || isJXPackaged)
      _loadSub(true);
    Module._load('_jx_subs', null, true);
  }
  else if (process._Monitor) {
    Module._load('_jx_monitorHelper', null, true);
  }
  else if (process._MTED)
    Module._load('_jx_multiplier', null, true);
  else if (process._EmbeddedSource) {
    Module._load('_jx_source', null, true);
  }
  else {
    var ngo = nodeGypOverride(process.argv[1], 'runMain');
    if (ngo)
        process.argv[1] = ngo;

    Module._load(process.argv[1], null, true);
  }

  // Handle any nextTicks added in the first tick of the program
  process._tickCallback();
};

var _loadSub = function(dontWait) {
  if (process.threadId == -1) return;

  if (!dontWait && !isThreadLoadingRoots()) {
    // since process.reloadModules is called only once per thread,
    // we should wait a little for NativeModule.Roots
    var _start = Date.now();
    while (!$uw.existsSource('NativeModule.Roots')) {
      sleep(2);
      var dx = Date.now() - _start;
      // practically we should wait as long as it takes...
      // however let's set up a limit 5 secs (for larger packages)
      if (dx > 5000) {
        jxcore.utils.console.warn('Thread no', process.threadId, ' will be reloading JX package into memory.\nYou might create this instance after the JX package is loaded.');
        break;
      }
    }
  }

  if ($uw.existsSource('NativeModule.Roots')) {
    NativeModule.RootsLength = 1;
    NativeModule.Roots = JSON.parse($uw.readSource('NativeModule.Roots'));
    for (var o in NativeModule.Roots) {
      if (!NativeModule.Roots.hasOwnProperty(o)) continue;
      var bns = NativeModule.Roots[o];
      for (var b in bns) {
        if (bns.hasOwnProperty(b) && bns[b] && bns[b].size) {
          bns[b] = new fs.JXStats(null, null, bns[b]);
        }
      }
    }
  }
};

getMemContent = function(location) {
  var data = $uw.readSource(location, true);
  var str = data.toString();
  data = null;

  return str;
};

_xo = function(_content) {
  var ex = $uw.readSource(_content, true);
  var _e = ex ? ex.toString() : '';
  ex = null;
  return wrapJS(_content, _e);
};

// Native extension for .jsonx
Module._extensions['.jsonx'] = function(module, filename) {
  if ($uw.existsSource('@' + filename)) {
    try {
      module.exports = JSON.parse(stripBOM(getMemContent('@' + filename)));
    } catch (err) {
      err.message = filename + ': ' + err.message;
      throw err;
    }
  }
  else
    Module._extensions['.json'](module, filename);
};

Module.setSourced = function(location, source, obj, verbose, preserve_chmod) {
  location = path.normalize(location);

  var getDirName = function(_loc) {
    var dn = _dirname(_loc);
    if (!dn)
      dn = path.dirname(_loc);

    return dn;
  };

  var toBeCreated = [];
  var color = jxcore.utils.console.setColor;
  var dir = getDirName(location);
  var _loc = location;

  if (process.platform === 'win32')
    preserve_chmod = false;

  // get ordered folder names to be created
  while (true) {
    var _dir = getDirName(_loc);
    if (__existsSync(_dir) || _dir === '.')
      break;

    toBeCreated.unshift(_dir);
    _loc = _dir;
  }

  if (toBeCreated.length) {
    for(var i = 0, len = toBeCreated.length; i < len; i++) {
      var _dir = toBeCreated[i];
      var msg = color('creating directory ', 'yellow') + _dir;

      var _loc = './' + _dir;
      var mode = null;
      if (preserve_chmod && obj.dirStats && obj.dirStats[_loc]) {
        // obj.dirStats[_loc] can be either number or entire stat object
        if (typeof obj.dirStats[_loc] === 'object' && typeof obj.dirStats[_loc].mode === 'number')
          mode = obj.dirStats[_loc].mode;
        else if (typeof obj.dirStats[_loc] === 'number')
          mode = obj.dirStats[_loc];
      }

      try {
        fs.mkdirSync(_dir);
        // mode needs to be set separately (not through options of mkdirSync)
        if (mode) {
          msg += color(' chmod ', 'yellow') + (mode & parseInt('777', 8)).toString(8);
          fs.chmodSync(_dir, mode);
        }
      } catch (ex) {
        msg += color(' Error: ', 'red') + ex;
        console.error(msg);
        process.exit(1);
      }

      if (verbose)
        console.log(msg);
    }
  }


  if (fs.existsSync(dir)) {

    var msg = color('extracting ', 'yellow') + location;
    var _loc = './' + location;
    var mode = null;
    if (preserve_chmod && obj.stats && obj.stats[_loc]) {
      var fileStats = JSON.parse(obj.stats[_loc]);
      if (fileStats.mode)
        mode = fileStats.mode;
    }

    try {
      fs.writeFileSync(location, source);
      // mode needs to be set separately (not through options of writeFileSync)
      if (mode) {
        msg += color(' chmod ', 'yellow') + (mode & parseInt('777', 8)).toString(8);
        fs.chmodSync(location, mode);
      }
    } catch (ex) {
      msg += color(' Error: ', 'red') + ex;
      console.error(msg);
      process.exit(1);
    }

    if (verbose)
      console.log(msg);
  }
};

var getRelative = function(parent, child) {
  var pdir = _dirname(parent);
  if (!pdir)
    pdir = path.dirname(parent);

  var cname = path.basename(child);

  var chilen = child.length;

  if (chilen > 0 && child.charAt(chilen - 1) == path.sep) {
    cname = '';
  }

  var cdir = _dirname(child);

  if (!cdir)
    cdir = path.dirname(child);

  if (pdir.indexOf('.' + path.sep) == 0) {
    if (pdir.length > 2)
      pdir = pdir.substr(2);
    else
      pdir = '';
  }

  if (cdir.indexOf('.' + path.sep) == 0) {
    if (cdir.length > 2)
      cdir = cdir.substr(2);
    else
      cdir = '';
  }
  var pdirs = pdir.split(path.sep);
  var cdirs = cdir.split(path.sep);

  var plen = pdirs.length - 1;
  var clen = cdirs.length;

  var n = 0;
  for (var i = 0; i < clen; i++) {
    if (cdirs[i]) {
      if (cdirs[i] == '..') {
        plen--;
        n++;
      }
      else if (plen >= i && cdirs[i] === pdirs[i]) {
        n++;
      }
      else {
        break;
      }
    } else {
      n++;
    }
  }

  var str = '';
  for (var i = 0; i <= plen; i++) {
    if (pdirs[i] == '.') {
      continue;
    }

    str += pdirs[i];

    if (str.length && str[str.length - 1] != path.sep)
      str += path.sep;
  }

  for (var i = n; i < clen; i++) {
    if (cdirs[i] == '.') {
      continue;
    }
    str += cdirs[i];

    if (str.length && str[str.length - 1] != path.sep)
      str += path.sep;
  }

  if (str.charAt(0) != path.sep && !isWindows) {
    str = path.sep + str;
  }
  if (cname.length == 0 && str.charAt(str.length - 1) == path.sep) {
    str = str.substr(0, str.length - 1);
  }

  if (str.length && str[str.length - 1] == path.sep &&
      cname.length && cname[0] == path.sep) {
    cname = cname.substr(1);
  }

  var result = (str + cname);

  if (result.length > 3) { // ends with /..
    if (result[result.length - 3] == path.sep &&
        result[result.length - 2] == '.' &&
        result[result.length - 1] == '.') {
      var ind = result.lastIndexOf(path.sep, result.length - 4);
      if (ind > 0) {
        result = result.substr(0, ind);
      } else {
        result = '..' + path.sep;
      }
    }
  }
  return result;
};

var runActions = function(actions, argName, native, verbose) {

  if (!actions)
    return true;

  if (!util.isArray(actions))
    actions = [actions];

  var jx = process.execPath;
  if (native)
    jx = findJXInPath();

  var quotedArg = '`' + argName + '`';

  if (verbose)
    jxcore.utils.console.log('Executing', quotedArg, 'steps:', 'cyan');

  var err = false;
  for (var o = 0, len = actions.length; o < len; o++) {
    var cmd = actions[o].trim();
    var quotedCmd = '`' + cmd + '`';
    if (verbose)
      jxcore.utils.console.write((o + 1) + '.', '\t', cmd, '...');

    if (cmd.indexOf('JX_BINARY') !== -1) {
      if (!jx) {
        var str =
            'JX_BINARY cannot be resolved because JXcore was not found ' +
            'in the PATH.';
        if (verbose)
          jxcore.utils.console.error(' Error:\n' + str);
        else // if not verbose, show error anyway
          jxcore.utils.console.error(
              'Cannot execute', quotedArg, 'step', quotedCmd, ':\n' + str);

        err = true;
        continue;
      } else
        cmd = cmd.replace('JX_BINARY', jx);
    }
    var ret = jxcore.utils.cmdSync(cmd);
    if (ret.exitCode) {
      var str = ret.out.trim();
      if (str) str += '. ';
      str += 'Exit code: ' + ret.exitCode + '.';

      if (verbose)
        jxcore.utils.console.error(' Error:\n' + str);
      else // if not verbose, show error anyway
        jxcore.utils.console.error(
            'Error while executing', quotedArg, 'step', quotedCmd, ':\n' + str);
      err = true;
    }

    if (!err && verbose) {
      jxcore.utils.console.log(' OK', 'green');
      if (ret.out && ret.out.trim())
        jxcore.utils.console.log(ret.out.trim());
    }
  }
  return err;
};

var __cwd;
var readX = function(m, f, obj, pa, eo) {
  var pn = obj.project.name + '@' + obj.project.version;

  var xpName = '~~' + pn.trim();
  while (xpName.indexOf(' ') >= 0) {
    xpName = xpName.replace(' ', '');
  }

  $uw.setSource('~~xpName', xpName);

  NativeModule.RootsLength = 1;

  var entry_file = pa == undefined || pa == null;
  var pass = false;
  var executed = false;
  obj.project.files = true;

  if (!obj.project.native && !obj.project.library && !entry_file &&
      process.argv[1] !== 'monitor' && process.argv[2] !== 'run') {
    throw f + ' can not be embedded into another project. ' +
        "It's marked as an executable.";
  }

  if (process._EmbeddedSource || entry_file) {
    if (!__cwd)
      __cwd = path.dirname(process.execPath) + path.sep;
    if (process._EmbeddedSource)
      f = __cwd + f;
  }

  if (obj.project.preInstall) {
    if (!fs.existsSync(obj.project.name + '.installed')) {
      runActions(obj.project.preInstall, 'preInstall', obj.project.native);
      fs.writeFileSync(obj.project.name + '.installed',
          'REMOVE THIS FILE TO RE-PLAY the preInstall Steps');
    }
  }

  var jx_package = require('_jx_package');
  var extract_options = jx_package.normalizeExtractOptions(eo, obj.project.native);

  var extract_what = null;
  var partialExtract = false;
  if (eo) {
    if (util.isArray(eo['what'])) {
      partialExtract = true;
      extract_what = jx_package.getPatchMatcher(eo['what']);
    }
  }

  var extract_verbose = eo ?
      jxcore.utils.argv.isBoolValue(eo['verbose']).isTrue : false;
  var extract_overwrite = eo ?
      jxcore.utils.argv.isBoolValue(eo['overwrite']).isTrue : false;
  var extract_where = eo ? eo['where'] : null;
  // default sub folder for extraction
  var subDir = obj.project.name;
  if (extract_where === './')
    subDir = '';
  else if (extract_where)
    subDir = extract_where;

  if (!entry_file) {
    // do not turn off for native packages
    //eo = false;
  } else if (obj.project.execute) {
    obj.project.execute = Module.nameFix(obj.project.execute);
    executed = true;
    obj.project.startup = obj.project.execute;
  }

  if (!$uw.existsSource(xpName)) {
    $uw.setSource(xpName, JSON.stringify(obj.project));
  }

  obj.project.name = Module.nameFix(obj.project.name);

  var org_location;
  if (eo && subDir) {
    if (fs.existsSync(subDir)) {
      var stat = fs.statSync(subDir);
      if (stat.isFile()) {
        jxcore.utils.console.warn(
            "Cannot extract the package to directory '%s'. " +
            'There is already a file with that name.', subDir);
        process.exit();
      } else if (stat.isDirectory() && !extract_overwrite) {
        jxcore.utils.console.warn(
            "Cannot extract the package to directory '%s'. " +
            'There is already a folder with that name.\n' +
            'Use `--extract-overwrite` switch for `jx package` command.',
            subDir);
        process.exit();
      }
      pass = true;
    } else {
      if (!__mkdirSync(subDir))
        return;

      org_location = process.cwd();
      process.chdir(subDir);
    }
  }

  if (!pass) {
    process.extracting = true;

    if (eo['pre-actions'])
      runActions(eo['pre-actions'], 'extract-pre-actions',
          obj.project.native, extract_verbose);

    if (eo['message'] && eo['message'].length) {
      // if extract-message is an array, benefit from formatting feature, etc.
      if (util.isArray(eo['message']))
        jxcore.utils.console.log.apply(null, eo['message']);
      else
        jxcore.utils.console.log(eo['message']);
    }

    for (var o in obj.docs) {
      if (!obj.docs.hasOwnProperty(o)) continue;
      var a = Module.nameFix(o);

      var doExtract = eo && (!partialExtract || (partialExtract &&
          extract_what && extract_what.test && extract_what.test(a)));
      var isStartup = getRelative(f, a) === getRelative(f, obj.project.startup);

      var doEmbed = !doExtract;
      if (obj.project.native || partialExtract) {
        // for native packages (and non-native partial extracts)
        // we should leave the startup file embedded to be able to run it
        if (isStartup) doEmbed = true;
      }

      if (doEmbed) {
        var a_embed = a;
        if (a_embed.length > 3) {
          if (a_embed.substr(a_embed.length - 3) != '.jx') {
            a_embed += '.jx';
          }
        }

        a_embed = getRelative(f, a_embed);
      }

      var __ext = path.extname(o);
      var isJS = __ext === '.js';
      var buff = null;
      var legacyPackaging = !obj.binary_packaging;
      if (legacyPackaging) {
        buff = new Buffer(obj.docs[o], 'base64');
        buff = jxt._ucmp(buff);
        // right now buff is still base64 encoded
        // we had so much base64 encoding before...
        if (!isJS)
          buff = new Buffer(buff.toString(), 'base64');
      } else {
        var _start = obj.docs[o].start;
        var _len = obj.docs[o].len;
        buff = jxt._ucmp(obj.binary_packaging.buffer.slice(_start, _start + _len));
      }

      // buff is uncompressed at this point
      if (!buff) {
        jxcore.utils.console.error('Error while decompressing:', o);
        continue;
      }

      if (o === "./package.json") obj.package_json = buff.toString();
      if (o === './' + obj.project.readme_file) obj.readme = buff.toString();
      if (o === './' + obj.project.license_file) obj.license = buff.toString();

      if (__ext == '.js') {
        if (doEmbed) {
          if (!obj.project.fs_reach_sources) {
            $uw.setSource('X@' + a_embed, '1');
          } else {
            if (obj.project.fs_reach_sources !== true &&
                !obj.project.fs_reach_sources[o]) {
              $uw.setSource('X@' + a_embed, '1');
            }
          }
        }
      }

      if (doExtract) {
        var write = true;
        // check overwrite only if extracting to app root folder.
        // For other folders check was already performed above.
        if (!subDir && !extract_overwrite && __existsSync(a))
          write = false;

        if (write) {
          Module.setSourced(a, buff, obj, extract_verbose, extract_options.chmod);
        } else {
          if (extract_verbose)
            jxcore.utils.console.log(jxcore.utils.console.setColor(
              'skipping (file already exists)', 'yellow'), path.normalize(a));
        }
      }

      if (doEmbed) {

        $uw.setSource('@' + a_embed, buff);
        var dn = path.dirname(a_embed);
        var bn = path.basename(a_embed);

        if (bn.substr(bn.length - 2) == 'jx')
          bn = bn.substr(0, bn.length - 3);

        if (!NativeModule.Roots[dn]) {
          NativeModule.Roots[dn] = {};
        }

        var _fstat = new fs.Stats(), _fnew;

        if (obj.stats)
          _fnew = new fs.JXStats(null, null, JSON.parse(obj.stats[o]));
        else
          _fnew = new fs.JXStats(buff.length, 33188);

        for (var o in _fnew) {
          if (!_fnew.hasOwnProperty(o)) continue;
          _fstat[o] = _fnew[o];
        }

        NativeModule.Roots[dn][bn] = _fstat;
      }

      buff = null;
    }

    delete obj.docs;
    delete obj.binary_packaging;
    jxcore.tasks.forceGC();

    // one-time adding folders not containing any files,
    // but containing sub-folders
    var _fstat1 = fs.statSync(process.cwd()); // real fs dir
    var _cwd = path.normalize(process.cwd());
    var addDir = function(o) {

      if (path.normalize(o) === _cwd || o.length < _cwd.length)
        return;

      var _dirname = path.dirname(o);
      var _basename = path.basename(o);

      if (NativeModule.Roots[_dirname] &&
          NativeModule.Roots[_dirname][_basename])
        return;

      if (__existsSync(o))
        return;

      if (!NativeModule.Roots[_dirname])
        NativeModule.Roots[_dirname] = {};

      NativeModule.Roots[_dirname][_basename] =
          new fs.JXStats(null, null, _fstat1);
      // go down until the process.cwd()
      addDir(_dirname);
    };

    for (var o in NativeModule.Roots) {
      if (NativeModule.Roots.hasOwnProperty(o))
        addDir(o);
    }

    delete process.extracting;

    if (eo['post-actions'])
      runActions(eo['post-actions'], 'extract-post-actions',
          obj.project.native, extract_verbose);
  }

  if (isThreadLoadingRoots()) {
    $uw.setSource('NativeModule.Roots', JSON.stringify(NativeModule.Roots));
  }

  if (entry_file) {
    var exito = false;
    if (process.argv[2] == 'readme') {
      jxcore.utils.console.warn(obj.readme || "JX file doesn't have a readme definition.\n");
      exito = true;
    } else if (process.argv[2] == 'license') {
      jxcore.utils.console.warn(obj.license ||
        "JX file doesn't have a license definition.\n" +
        "This might be a bug or the package doesn't have a license file." +
        '\nIf this is a bug, please let us know from support@jxcore.com\n');
      exito = true;
    }

    if (exito) {
      var ww = obj.project.website;
      if (!ww) {
        if (obj.package_json)
          obj.packo = JSON.parse(obj.package_json);

        if (obj.packo) {
          if (obj.packo.homepage) {
            ww = obj.packo.homepage;
          } else if (obj.packo.repository) {
            ww = obj.packo.repository.url;
          }
        }
      }
      if (ww) {
        // partial solution to have this printed on windows when piped
        // (e.g. executed through child_process)
        var _log = isWindows ? jxcore.utils.console.warn : jxcore.utils.console.info;

        _log('You may want to visit (' + ww +
             ') for more information about the package.');
      }
      try {
        process.exit();
      } catch (e) {
      }
      return false;
    }

    if (eo && !partialExtract) {
      if (process.argv[2] != 'readme' && process.argv[2] != 'license') {
        if (obj.project.execute || obj.project.startup) {
          var so = obj.project.execute || obj.project.startup;
          so = so.replace('.' + path.sep, '');
          so = so.replace('./', ''); // for windows

          var floc = path.join(subDir, so);
          var cwd = process.cwd();
          if (!pass && org_location)
            cwd = org_location;

          jxcore.utils.console.log('executing', floc, 'yellow');

          var argz = [floc].concat(process.argv.slice(2));
          var _code = 0;
          require('child_process').spawn(process.execPath, argz, {
            stdio: 'inherit',
            cwd: cwd
          }).on('close', function(code) {
            _code = code;
            jxcore.utils.continue();
          });
          // hang this process. needs jump() instead of pause()
          // (to be able to return back from closed child)
          jxcore.utils.jump();

          // exit with same exit code as child
          process.exit(_code);
          return false;
        }
      }

      try {
        process.exit();
      } catch (e) {
      }
      return false;
    }
  }

  var q = obj.project.startup;
  if (q.length > 3) {
    var m_ext = q.substr(q.length - 3), found = false;
    if (m_ext[0] != '.') {
      q += path.sep + 'index.js.jx';
      q = Module.nameFix(q);
      q = getRelative(f, q);
      if (!$uw.existsSource('@' + q)) {
        q = obj.project.startup;
      } else {
        found = true;
      }
    }

    if (!found) {
      if (m_ext != '.jx') {
        if (m_ext != '.js') {
          q += '.js';
        }
        q += '.jx';
      }
      q = Module.nameFix(q);
      q = getRelative(f, q);
    }
  }
  else {
    q = Module.nameFix(q);
    q = getRelative(f, q);
  }

  if (executed) {
    if (!$uw.existsSource('@' + q)) {
      console.log("File doesn't exist", q);
      try {
        process.exit();
      } catch (e) {
      }
      return false;
    }
  }

  var was_embedded = process._EmbeddedSource;
  if (process._EmbeddedSource) {
    var mfile = path.join(__cwd, obj.project.startup);
    if (path.extname(mfile) == '.js') {
      mfile += '.jx';
    }

    process.mainModule.filename = mfile;
    $uw.setSource('_EmbeddedSource.mainModule.filename', mfile);

    NativeModule.require('_jx_config');
    process.argv[0] = process.execPath;
    delete(process.mainModule.fileSource);
    delete(process._EmbeddedSource);
  }

  jxcore.tasks.forceGC();

  m._filename = q;
  $uw.setSourceIfNotExists('??' + f, '1');

  obj.project.startup = getRelative(f, obj.project.startup);
  obj.project.startup = Module._resolveFilename(obj.project.startup, m);

  if (!was_embedded && entry_file) {
    $uw.setSource('_EmbeddedSource.mainModule.filename', obj.project.startup);
    process.mainModule.filename = obj.project.startup;
  }

  Module._cache[obj.project.startup] = new Module(obj.project.startup, m);

  m._compile('@' + q, obj.project.startup, true, true, false);

  obj = null;

  jxt._ucmp(null);
  return true;
};


var getMainFile = function(fold) {
  var zt = fold;
  var ret = 'index.js';
  if (NativeModule.Roots[zt]) {
    if (NativeModule.Roots[zt]['package.json']) {
      zt += path.sep + 'package.json.jx';
      var source = getMemContent('@' + zt);
      var js = JSON.parse(source);
      if (js.main) {
        ret = js.main.replace('.' + path.sep, '');
        ret = Module.nameFix(ret);
        if (isWindows) {
          if (ret.length > 2) {
            if (ret.charAt(0) == '.' && ret.charAt(1) == path.sep) {
              ret = ret.substr(2);
            }
          }
        }

        var _extname = path.extname(ret);
        if (!_extname) {
          fold += path.sep + ret;
          if (NativeModule.Roots[fold]) {
            if (NativeModule.Roots[fold]['index.js.jx'] ||
                NativeModule.Roots[fold]['index.js']) {
              return ret + path.sep + 'index.js';
            }
          }
          var drname = path.dirname(fold);
          var bsname = path.basename(fold);
          if (NativeModule.Roots[drname][bsname + '.js.jx']) {
            ret += '.js';
          }
          else if (!NativeModule.Roots[fold + path.sep + ret]) {
            ret += '.js';
          }
          else ret += path.sep + 'index.js';
        }
      }
    } else {
      var bsname = path.basename(fold);
      if (NativeModule.Roots[fold]['index.js.jx'])
        return fold + 'index.js.jx';

      if (NativeModule.Roots[fold][bsname + '.js.jx'])
        return fold + bsname + 'js.jx';
    }
  }
  return ret;
};

var getCheckedName = function(a, org) {
  if (org && (a === org || a + '.js.jx' === org))
    return 0;

  if ($uw.existsSource('@' + a)) {
    return a;
  }

  if ($uw.existsSource('@' + a + '.jx')) {
    return a + '.jx';
  }

  if ($uw.existsSource('@' + a + '.js.jx')) {
    return a + '.js.jx';
  }

  if ($uw.existsSource('@' + a + '.json.jx')) {
    return a + '.json.jx';
  }

  return null;
};

var fixByFolder = function(a) {
  if (NativeModule.Roots[a]) {
    var mfile = getMainFile(a);
    if (NativeModule.Roots[a][mfile]) {
      a += path.sep + mfile;
    }
    else {
      var newpath = a + path.sep + mfile;
      var ndir = path.dirname(newpath);
      var nbase = path.basename(newpath);
      var found = false;
      if (NativeModule.Roots[ndir]) {
        if (NativeModule.Roots[ndir][nbase]) {
          a += path.sep + getMainFile(a);
          found = true;
        }
      }

      if (!found) {
        newpath = a + path.sep + (mfile.replace(path.extname(mfile), ''));
        if (NativeModule.Roots[newpath]) {
          return fixByFolder(newpath);
        }
      }
    }
  }
  return a;
};

Module._resolveFilename = function(r, p, ___, ____, __subCheck) {

  var ngo = nodeGypOverride(r, '_resolveFilename');
  if (ngo)
    return ngo;

  if (NativeModule.exists(r)) {
    return r;
  }

  if (!NativeModule.RootsLength)
    return Module._oldRes(r, p);

  if (!r) {
    throw ('Fatal: no parameter given to require.');
  }

  var host_name = p ? p.id : null;
  var found_target = null;
  var a = getCheckedName(r, host_name);
  if (a === 0) found_target = r; // do not use this yet. search for modules
  if (a) {
    return a;
  }

  a = Module.nameFix(r).trim();
  var subCheck = null;

  var ntarget = (p ? (p.id || p.filename) : null);
  if (ntarget && a[a.length - 1] == path.sep) {
    a = path.join(path.dirname(ntarget), a);
    if (a[a.length - 1] == path.sep)
      a = a.substr(0, a.length - 1);
    a = fixByFolder(a);
  }

  if (!__subCheck) {
    if (a.length && a[a.length - 1] == path.sep) {
      subCheck = a.substr(0, a.length - 1);
      a = subCheck;
      subCheck += path.sep + getMainFile(subCheck);
    }
    if (a == '.') {
      a = Module.nameFix('./index.js');
    }
  }
  else {
    a = __subCheck;
  }

  var qq = a, paths = [];

  var ex = null;
  var mod_loc = null;
  if (p && (p.id || p.filename)) {
    paths = p.paths;
    if (p.parent) {
      var q = p.parent;
      while (true) {
        var fn = q.id ? q.id : q.filename;
        if (fn.indexOf('.js.jx') > 0 || fn.indexOf('.json.jx') > 0) {
          if (q.parent) {
            q = q.parent;
          }
          else {
            break;
          }
        }
        else if (fn.indexOf('.jx') > 0) {
          break;
        }
        else {
          break;
        }
      }
      paths = q.paths;
    }

    var z = p._filename;
    if (!z)
      z = p.filename;

    if (z) {
      ex = path.extname(z);
    }
    if (ex == '.jx') {
      var sub = path.dirname(z);
      if (NativeModule.Roots[sub + path.sep + 'node_modules' + path.sep + a]) {
        mod_loc = sub + path.sep + 'node_modules' + path.sep + a;
      }
      a = getRelative(sub + path.sep, a);
      if (a.length > 2 && a[0] == path.sep && a[1] == path.sep)
        a = a.substr(1);
    } else {
      sub = p.id;
      a = getRelative(sub, a);
    }
  }

  var ext = path.extname(a);

  if (ext == '.jx') {
    var q = a.lastIndexOf(path.sep);
    a = '.' + path.sep + a.substr(q + 1);
  }

  var isModuleName = r.indexOf('/') === -1 && r.indexOf('\\') === -1;
  var res1 = getCheckedName(a, host_name);
  if (!found_target && res1 === 0)
    found_target = a; // do not use this yet. search for modules
  // if both name.js and "name" module exist - allow the module first
  if (res1 && !isModuleName) {
    return res1;
  }

  var plast = a.lastIndexOf(path.sep);
  if (plast > 0 && ext == '' && !NativeModule.Roots[a] &&
      plast + 1 < a.length) {
    var anext = a.substr(0, plast);
    var apre = a.substr(plast + 1);
    var nname = anext + path.sep + 'node_modules' + path.sep + apre;
    if (NativeModule.Roots[nname]) {
      a = nname;
    }
  }

  a = fixByFolder(a);
  var res = getCheckedName(a, host_name);
  if (!found_target && res === 0)
    found_target = a; // do not use this yet. search for modules
  if (res && !isModuleName) {
    return res;
  }

  // if not found in node_modules, but found the file before - use it
  if (res1 && !isModuleName) {
    return res1;
  }

  if (mod_loc) {
    a = fixByFolder(mod_loc);
    res = getCheckedName(a, host_name);
    if (!found_target && res === 0)
      found_target = a; // do not use this yet. search for modules
    if (res && !isModuleName) {
      return res;
    }
  }

  if (ext == '.jx' || ex == '.jx') {
    var predir = path.dirname(a);
    var loc = 1;

    paths = paths.concat(modulePaths);
    for (var ki = 0; ki < 10; ki++) {
      loc = predir.lastIndexOf(path.sep);
      if (loc > 0) {
        predir = predir.substr(0, loc);
        if (predir.charAt(0) == '.' && predir.charAt(1) == path.sep) {
          predir = predir.substr(2);
        }
        paths.push(predir);
      } else {
        break;
      }
    }
    var checkeds = {};
    var zq = path.join('node_modules', qq);

    for (var o in paths) {
      if (!paths.hasOwnProperty(o)) continue;
      var pp = paths[o];

      res = checkin(pp, zq, checkeds);
      if (res)
        return res;
    }

    for (var o in paths) {
      if (!paths.hasOwnProperty(o)) continue;
      var pp = paths[o];

      res = checkin(pp, qq, checkeds);
      if (!found_target && res === 0)
        found_target = a; // do not use this yet. search for modules
      if (res) {
        if (!isModuleName)
          return res;
        else
          break;
      }
    }
    checkeds = null;
  }

  if (subCheck) {
    return Module._resolveFilename(r, p, null, null, subCheck);
  }

  // there still can be node_modules/some_module present in filesystem
  if (found_target) {
    try {
      return Module._oldRes(r, p);
    } catch (ex) {
      return getCheckedName(found_target);
    }
  }

  return Module._oldRes(r, p);
};

var checkin = function(pp, zq, checkeds) {
  if (pp && pp.length) {
    if (pp[0] == '.') {
      pp = pp.substr(1);
    }
    var io = pp.length - 12;
    if (io > 0 && pp.indexOf('node_modules') == io) {
      pp = pp.substr(0, io);
    }
  } else {
    return null;
  }

  if (checkeds[pp + zq])
    return null;

  checkeds[pp + zq] = 1;

  var xx = getRelative(pp + path.sep, zq);

  var ires = null;
  if (NativeModule.Roots.hasOwnProperty(xx)) {
    ires = getCheckedName(xx + path.sep + getMainFile(xx));
  }

  if (!ires)
    ires = getCheckedName(xx);

  if (ires) {
    return ires;
  }

  xx = xx + path.sep + getMainFile(xx);

  ires = getCheckedName(xx);
  if (ires) {
    return ires;
  }

  return null;
};

var sleep = function(timeout) {
  setTimeout(function() {
    jxcore.utils.continue();
  }, timeout);
  jxcore.utils.pause();
};


Module._extensions['.jx'] = function(m, f, pa) {
  if (f.indexOf('.json.jx') > 0) {
    Module._extensions['.jsonx'](m, f);
    return;
  }

  _loadSub();

  if ($uw.existsSource('@' + f)) {
    m._compile('@' + f, f, true, true);
    return;
  }

  var sets = $uw.setSourceIfNotExists('?' + f, '1');

  // threadId could be bigger than 0 but still it may not
  // be a subthread. (embedded multithreading)
  if (process.threadId > 0 && process.subThread) {
    var skip = false;
    if (!sets) {
      var counter = 0;
      var h = f.substr(0, f.length - 3) + '.js.jx';

      // this is very ugly but we give some time to main thread
      // to read from the file system so we wouldn't do the same
      // for sub threads. max 2sec
      while (!$uw.existsSource('??' + f)) {
        sleep(2);
        if (counter++ > 1000) {
          skip = true;
          break;
        }
      }
      if (!skip) {
        if ($uw.existsSource('@' + h)) {
          if (!pa) {
            process.mainModule.filename = h;
          }
          m._compile('@' + h, h, true, true);
          return;
        }
      }
    }
  }

  var buffer, obj;
  if (!m.fileSource) {
    buffer = fs.readFileSync(f);
  } else {
    buffer = m.fileSource;
  }

  var jx_package = require('_jx_package');
  var firstNumber = jx_package.bufferToNumber(buffer, buffer.length - 8);
  var secondNumber = jx_package.bufferToNumber(buffer, buffer.length - 4);
  var legacyPackaging = secondNumber !== firstNumber + 12345;

  if (legacyPackaging) {
    obj = JSON.parse(jxt._ucmp(buffer, 1));
    if (!process.noDeprecation) {
      jxcore.utils.console.warn('Your package was created with older JXcore packaging format ' +
      'which is currently depreciated and its support will be removed in future JXcore releases.')
      jxcore.utils.console.log('Don\`t worry, for the moment the package can still be executed.');
      jxcore.utils.console.log('However we recommend recreating a package ' +
      'using the latest JXcore version (also for better performance).');
    }
  } else {
    var _size = firstNumber;
    // the `obj` is just a part of a buffer
    obj = JSON.parse(jxt._ucmp(buffer.slice(0, _size), 1));
    if (!obj.binary_packaging)
      obj.binary_packaging = {};
    obj.binary_packaging.buffer = buffer.slice(_size);
  }

  buffer = null;
  if (!obj.project) {
    var err = new Error('Package is either corrupted or not ' +
                        'compatible with this JX binary. (' + f + ')');

    throw err;
  }

  jxcore.tasks.forceGC();
  return readX(m, f, obj, pa, obj.project.extract);
};


var wrapJS = function(fname, fileSource) {

  var xpName = $uw.readSource('~~xpName');

  if (!xpName)
    throw "Variable xpName is not defined.";

  fname = fname.replace(process.cwd(), '');

  var keepb = '/*ouvz&tJXPoaQnod*/\n';
  if (fname.indexOf('node_modules') < 0)
    keepb += "exports.__defineGetter__('$JXP',function(){var " +
    "js = JSON.parse(process.binding('memory_wrap').readSource('" +
    xpName + "')); js.bind=function(){}; return js;});\n";
  var keep = '\n/*mouvz&tJXPoaQnodeJX&vz*/';

  // also remove shebang
  return keepb + fileSource.replace(/^\#\!.*/, '') + keep;
};

(function(global){
// create compile function for different platforms
var compile = typeof process === "object" ? 
	function(source, name){
		return process.compile("(" + source + ")", name);
	} :
	typeof Packages === "object" ?
	function(source, name){
		return Packages.org.mozilla.javascript.Context.getCurrentContext().compileFunction(global, source, name, 1, null);
	} : eval;

if(typeof require == "undefined"){
	// presumably this would only happen from a direct start in rhino
	var args = global.arguments;
	// bootstrap require
	require = makeRequire("file://" + args[0]);
	require.paths = [];
}

exports.newInstance = function(exports, options) {

options = options || {};

var dump = function() {},
    modules = {},
	factories = {},
	waitingOn = 0,
	inFlight = {},
	monitored = [],
	overlays = {},
	callbacks = [],
	currentModule,
	currentRequire,
	useSetInterval = false,
	monitorModules = true,
	packages = {},
	filePathMappings = [],
	defaultPath = "",
	main = null,
	Unzip = require("./nodules-utils/unzip").Unzip,
	promiseModule = require("./nodules-utils/promise"),
	when = promiseModule.when,
	system = require("./nodules-utils/process"),
	print = system.print,
	zipInflate = require("./nodules-utils/inflate").zipInflate,
	paths = require.paths,
	defaultRequire = require,
	allKnownOverlays = {npm: true, narwhal: true, rhino: true, node: true},
    sync = options.sync || false,
    debug = options.debug || false,
    plugins = {};

if(typeof process === "undefined"){
    if(typeof CC == "undefined"){
        var request = require("./nodules-utils/rhino-http-client").request,
            schedule = require("./nodules-utils/rhino-delay").schedule,
            enqueue = require("event-loop").enqueue,
            fs = require("./nodules-utils/rhino-fs");
    }else{
        // narwhal-xulrunner (gecko)
        var dump = function(obj) { print(require('test/jsdump').jsDump.parse(obj)) },
            request = require("./nodules-utils/rhino-http-client").request,
            schedule = require("./nodules-utils/xulrunner-delay").schedule,
            fs = require("./nodules-utils/rhino-fs");
        if(sync) {
            enqueue = function(callback, delay) { callback(); };
        } else {
            enqueue = require("event-loop").enqueue;
        }
    }
}else{
	var request = require("./nodules-utils/node-http-client").request,
		schedule = require("./nodules-utils/node-delay").schedule,
		enqueue = process.nextTick,
		fs = require("./nodules-utils/node-fs");
}
var moduleExports = {
		promise: promiseModule,
		"fs-promise": fs,
		"nodules": exports,
		system: system
	};

exports.factories = factories;

function EnginePackage(engine){
	var enginePackage = this;
	this.useLocal= function(){
		var packageJson = "{}",
			path = fs.absolute(".");
		function findPackage(path){
			try{
				packageJson = fs.read(path + "/package.json");
			}catch(e){
				if(path.lastIndexOf('/') < 1 && path.lastIndexOf('\\') < 1){
					throw new Error("Couldn't find package.json");
				}
				return findPackage(path.substring(0, Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\'))));
			}
			return path;
		}
		try{
			path = findPackage(path);
		}catch(e){}
		try{
			var parsed = JSON.parse(packageJson);
		}catch(e){
			e.message += " trying to parse local package.json";
			throw e;
		}
		if(path.charAt(path.length - 1) == '\\' || path.charAt(path.length - 1) == '/'){
			path = path.substring(0, path.length - 1);
		}
		return enginePackage.usePackage(parsed, "file://" + path);
	};
	this.usePackage= function(packageData, path){
		processPackage(path, packageData, engine); 
		if(path){
			packageData.mappings.defaultPath = path + "/lib/";
		}
		for(var i in packageData){
			enginePackage[i] = packageData[i];
		}
		return enginePackage;
	};
	
	this.getModuleSource = function(id){
		try{
			return fs.read(enginePackage.getCachePath(id));
		}catch(e){
			if(id.indexOf(":") === -1 && moduleExports[id.substring(0, id.length - 3)]){
				try{
					return fs.read(__dirname+ "/nodules-utils/" + id);
				}
				catch(e){}
			}
		}
	};
	this.getCachePath= function(id){
		if(id.substring(id.length - 3) == ".js"){
			id = id.substring(0, id.length - 3);
		}
		var uri = resolveUri("", id, enginePackage.mappings);
		if(id.charAt(id.length -1) == "/"){
			uri = uri.substring(0, uri.lastIndexOf("."));
		}
		if(uri.substring(0,7) == "file://"){
			return uri.substring(7);
		}
		return cachePath(uri);
	};	
}

var define = function (id, injects, factory) {
    if (currentModule == null) {
      throw new Error("define() may only be called during module factory instantiation");
    }
    var module = currentModule;
    var require = currentRequire;
    if (!factory) {
      // two or less arguments
      factory = injects;
      if (factory) {
        // two args
        if (typeof id === "string") {
          if (id !== module.id) {
            throw new Error("Can not assign module to a different id than the current file");
          }
          // default injects
          injects = ["require", "exports", "module"];
        }
        else{
          // anonymous, deps included
          injects = id;
        }
      }
      else {
        // only one arg, just the factory
        factory = id;
        injects = ["require", "exports", "module"];
      }
	}
    if (typeof factory !== "function"){
      // we can just provide a plain object
      return module.exports = factory;
    }
    var returned = factory.apply(module.exports, injects.map(function (injection) {
      switch (injection) {
        // check for CommonJS injection variables
        case "require": return require;
        case "exports": return module.exports;
        case "module": return module;
        default:
          // a module dependency
          return require(injection);
      }
    }));
    if(returned){
      // since AMD encapsulates a function/callback, it can allow the factory to return the exports.
      module.exports = returned;
    }
};

exports.registerPlugin = function(name, plugin) {
    plugins[name] = plugin;
}

packages[""] = exports;
exports.mappings = [];
exports.mappings.defaultPath = "";

exports.forBrowser = function(){
	return new EnginePackage("browser");
};
exports.forEngine = function(engine){
	return new EnginePackage(engine);
};

exports.ensure = makeRequire("").ensure;
exports.runAsMain = function(uri){
	if(!uri || uri.indexOf(":") === -1){
		uri = "file://" + fs.absolute(uri || "lib/index.js");
	}
	main = modules[uri] = modules[uri] || new Module(uri); 
	return exports.ensure(uri, function(require){
		require(uri);
	});
};

EnginePackage.call(exports, exports.usingEngine = typeof process !== "undefined" ? "node" : "narwhal");

function Module(uri){
	this.id = uri;
	this.dependents = {};
}

Module.prototype.supportsUri = true;
Module.prototype.setExports = function(exports){
	this.exports = exports;
}

exports.baseFilePath = options.path || "downloaded-modules";
try{
	var filePathMappingsJson = fs.read(exports.baseFilePath + "/paths.json");
}catch(e){}
filePathMappingsJson = filePathMappingsJson || options.pathMappings || false;
if(filePathMappingsJson){
    var filePathMappingsObject = (typeof filePathMappingsJson == "string")?JSON.parse(filePathMappingsJson):filePathMappingsJson;
	useSetInterval = filePathMappingsObject.useSetInterval;
	monitorModules = filePathMappingsObject.monitorModules !== false;
	for(var i in filePathMappingsObject){
		filePathMappings.push({
			from: RegExp(i),
			to: filePathMappingsObject[i]
		});
	}
}

function reloadable(onload){
	var onChange = function(){
		monitored.push(onChange);
		onload();
	}
	onChange();
}
function resolveUri(currentId, uri, mappings){
    var pluginInfo = uri.match(/^(\w+)!(.+?)$/);
    if(pluginInfo && pluginInfo[1]) {
        uri = pluginInfo[2];
    }
	if(uri.charAt(0) === '.'){
		var extension = currentId.match(/\.[\w]+$/);
		extension = extension ? extension[0] : "";
        if(pluginInfo && pluginInfo[1]) {
            extension = "";
        }
		uri = currentId.substring(0, currentId.lastIndexOf('/') + 1) + uri;
		while(lastUri !== uri){
			var lastUri = uri;
			uri = uri.replace(/\/[^\/]*\/\.\.\//,'/');
		}
		return [uri.replace(/\/\.\//g,'/')] + extension;
	}
	else if(uri.indexOf(":") > -1){
		return uri;
	}else{
		if(mappings){
            var extension = uri.match(/\.[\w]+$/) || ".js";
			for(var i = 0; i < mappings.length; i++){
				var mapping = mappings[i];
				var from = mapping.from;
				if(mapping.exact ? uri === from : uri.substring(0, from.length) === from){
					uri = mapping.to + uri.substring(from.length);
					return uri.match(/\.\w+$/) ? uri : uri + (getPackage(uri).extension || extension);
				}
			}
			var packageData = getPackage("");
			if(!uri.match(/\.\w+$/) && !(packageData.usesSystemModules && packageData.usesSystemModules.indexOf(uri) > -1)){
				uri = mappings.defaultPath +uri + (packageData.extension || extension);
			}
		}
		return uri;
	}
}
function getPackageUri(uri, source){
    var packageUri;
    // check for source defined package URI
    if(source && (packageUri = source.match(/package root: (\w+:.*)/)) && packageUri) {
        return packageUri[1];
    }
    else if(uri.substring(0,4) == "jar:"){
        // if it is an archive, the root should be the package URI
        return uri.substring(0, uri.lastIndexOf('!') + 2);
    }
    else if(uri.substring(0,5) == "file:" && uri.lastIndexOf('!/')>0){
        // if it is a file URI and contains a !/ the string prior to ! is the package URI
        return uri.substring(0, uri.lastIndexOf('!/')) + "/";
    }
    else if(uri.substring(0,7) == "memory:" && uri.lastIndexOf('!/')>0){
        // if it is a memory URI and contains a !/ the string prior to ! is the package URI
        return uri.substring(0, uri.lastIndexOf('!/')) + "/";
    }
    else{
        // else try to base it on the path
        return uri.substring(0, uri.lastIndexOf('/lib/') + 1);
    }
}
var getPackage = exports.getPackage = function(uri){
	return packages[getPackageUri(uri)] || {mappings: packages[""].mappings};
}
function makeWorker(Constructor, currentId){
	return Constructor && function(script, name){
		var worker = Constructor("nodules-worker.js", name);
		var mappings = getPackage(currentId).mappings;
		worker.postMessage(resolveUri(currentId, script, mappings));
		return worker;
	}
}
function makeRequire(currentId){
    if(debug) print("[nodules][makeRequire] currentId: " + currentId);
	var require = function(id){
        if(debug) print("[nodules][makeRequire][require] id: " + id);
        if(debug) print("[nodules][makeRequire][require] currentId: " + currentId);
        if(debug) print("[nodules][makeRequire][require] getPackage(currentId).mappings: ");
        if(debug) dump(getPackage(currentId).mappings);
		var pkg = getPackage(currentId),
            uri = resolveUri(currentId, id, pkg.mappings),
            ret;
        if(debug) print("[nodules][makeRequire][require] uri: " + uri);
        if(plugins["processModule"] && plugins["processModule"].fetchExports &&
           (ret = plugins["processModule"].fetchExports(uri, id, currentId, pkg))) {
            modules[uri] = modules[uri] || new Module(uri);
            moduleExports[uri] = ret;
        }
		if(moduleExports[uri]){
			modules[uri].dependents[currentId] = true;
            if(debug) print("[nodules][makeRequire][require] moduleExports[uri] found");
			return moduleExports[uri];
		}
		if(factories[uri]){
            if(debug) print("[nodules][makeRequire][require] factories[uri] found");
			try{
				var exports = moduleExports[uri] = {},
					module = currentModule = modules[uri] = modules[uri] || new Module(uri),
					currentFile = cachePath(uri),
					factory = factories[uri],
					originalExports = module.exports = exports,
					nextRequire = currentRequire = makeRequire(uri);
				module.dependents[currentId] = true;
				exports = factory.call(exports, nextRequire, exports, module, define,
						currentFile, currentFile.replace(/\/[^\/]*$/,'')) 
							|| exports;
				if(factory != factories[uri]){
					// if a module was wrapped with the transport/D than the factory will get replaced
					exports = factories[uri].call(exports, nextRequire, exports, module, define, 
							currentFile, currentFile.replace(/\/[^\/]*$/,'')) 
								|| exports;
				}
				if(originalExports != module.exports){
					exports = module.exports;
				}
				Object.defineProperty(module, "exports",{value:exports});
				moduleExports[uri] = exports;
				var successful = true;
			} catch(e){
                if(debug) print("[nodules][makeRequire][require] ERROR: " + e);
            } finally{
				currentRequire = null;
				currentModule = null;
				if(!successful){
					delete moduleExports[uri];
				}
			}
			return exports;
		}
		if(uri.indexOf(":") === -1){
			id = uri;
			if(id.substring(id.length - 3) == ".js"){
				id = id.substring(0, id.length - 3);
			}
		}
        if(debug) print("[nodules][makeRequire][require] id: " + id);
		try{
			return moduleExports[id] || defaultRequire(id); 
		}catch(e){
			if(e.message.substring(0, 19) == "Can not find module"){
				throw new Error("Can not find module " + uri);
			}
			if(e.message.substring(0, 28) == "require error: couldn't find"){
				throw new Error("Can not find module " + uri);
			}
            if(debug) print("[nodules][makeRequire][require] ERROR: " + e);
			throw e;
		}
	};
	require.main = main;
	require.define = function(moduleSet, dependencies){
		if(dependencies){
			require.ensure(dependencies);
		}
		var context = getPackageUri(currentId) + "lib/";
		for(var i in moduleSet){
			var moduleDef = moduleSet[i];
			factories[context + i + ".js"] = moduleDef.factory || moduleDef;
		}
	};
	require.def = define;
/*	require.def = function(id, dependencies, factory){
		if(dependencies){
			require.ensure(dependencies);
		}else{
			factory = dependencies; 
		}
		factories[getPackageUri(currentId) + "lib/" + id + ".js"] = function(require, exports, module){
			return factory.apply(exports, dependencies ? dependencies.map(function(id){
				switch(id){
					case "require": return require;
					case "exports" : return exports;
					case "module" : return module;
					default: return require(id);
				}
			}) : []);
		};
	};*/
	require.paths = paths;
	require.reloadable = reloadable;
	require.resource = function(uri){
		uri = resolveUri(currentId, uri, getPackage(currentId).mappings);
		return factories[uri];
	}
	var ensure = require.ensure = function(id, callback){
        if(debug) print("[nodules][makeRequire.ensure] id: " + id);
		var require = makeRequire(uri);
		if(id instanceof Array){
            if(debug) print("[nodules][makeRequire.ensure] if(id instanceof Array): true");
            if(debug) print("[nodules][makeRequire.ensure] id: ");
            if(debug) dump(id);
			if(!id.length){
				return callback && callback();
			}
			var uri = resolveUri(currentId, id[0], getPackage(currentId).mappings),
				require = makeRequire(uri);
			waitingOn++;
			if(callback){
				callbacks.unshift(callback);
			}
			try{
				var results = id.map(ensure);
			}finally{
				decrementWaiting();
			}
			return results;
		}
        if(debug) print("[nodules][makeRequire.ensure] currentId: " + currentId);
		var pkg = getPackage(currentId),
            uri = resolveUri(currentId, id, pkg.mappings),
			require = makeRequire(uri),
			i = 0,
            ret;
        if(debug) print("[nodules][makeRequire.ensure] uri: " + uri);
        if(plugins["processModule"] && plugins["processModule"].fetchFactory &&
           (ret = plugins["processModule"].fetchFactory(uri, id, currentId, pkg))) {
            factories[uri] = ret;
        }
		if(factories[uri]){
            if(debug) print("[nodules][makeRequire.ensure] if(factories[uri]): true");
			if(typeof callback == "function"){
				callback(require);
			}
			return;
		}
		if(typeof callback == "function"){
            if(debug) print("[nodules][makeRequire.ensure] typeof callback: function");
			callbacks.unshift(callback);
		}
		if(uri.indexOf(':') < 0 || inFlight[uri]){
            if(debug) print("[nodules][makeRequire.ensure] uri.indexOf(':') < 0: " + (uri.indexOf(':') < 0));
            if(debug) print("[nodules][makeRequire.ensure] if(inFlight[uri]): " + ((inFlight[uri])?1:0) );
            if(debug) print("[nodules][makeRequire.ensure] return");
			return;
		}
		function onError(error){
            if(debug) print("[nodules][makeRequire.ensure][onError] uri: " + uri);
            if(debug) print("[nodules][makeRequire.ensure][onError] error: " + error);
			if(uri.indexOf(":") === -1){
				id = uri;
				if(id.substring(id.length - 3) == ".js"){
					id = id.substring(0, id.length - 3);
				}
			}
			try{
				//check to see if it is a system module
				moduleExports[id] || defaultRequire(id);
			}catch(e){
				factories[uri] = function(){
					throw new Error(error.message + " failed to load " + uri);
				};
			}				
			decrementWaiting();
		}
		function decrementWaiting(){
			waitingOn--;
			if(waitingOn === 0){
				var calling = callbacks;
				callbacks = [];
				inFlight = {};
				calling.forEach(function(callback){
					enqueue(function(){
						callback(require);
					});
				});
			}
		}
		waitingOn++;
		inFlight[uri] = true;
		try{
			var source = exports.load(uri, require);
			return when(source, function(source){
				try{
					if(source !== undefined){
						var packageData = getPackage(uri);
						if(packageData && packageData.compiler){
							var deferred = promiseModule.defer();
							require.ensure(packageData.compiler.module, function(){
								try{
									var rewrittenSource = require(packageData.compiler.module)[packageData.compiler["function"] || "compile"](source);
									createFactory(uri, rewrittenSource);
									deferred.resolve();
								}catch(e){
									e.message += " compiling " + uri;
									deferred.reject(e);
								}
							});
							return deferred.promise;
						}
						createFactory(uri, source);
						return exports;
					}
				}finally{
					decrementWaiting();
				}
			}, onError);
		}
		catch(e){
			onError(e);
		}
	};
	return require;
}
function processPackage(packageUri, packageData, engine){
    if(debug) print("[nodules][processPackage] packageUri: " + packageUri);
	engine = engine || exports.usingEngine;
	var mappings = packageData.mappings || {};
    if(debug) print("[nodules][processPackage] mappings: ");
    if(debug) dump(mappings);
	var mappingsArray = packages[""].mappings;
	var defaultPath = mappingsArray.defaultPath;
	function addMappings(mappings){
		if(mappings){
			mappingsArray = mappingsArray.concat(Object.keys(mappings).map(function(key){
                if(debug) print("[nodules][processPackage][addMappings] key: " + key);
				var to = mappings[key],
                    id,
                    info,
                    ret;
                if(plugins["processPackage"] && plugins["processPackage"].normalizeMapping &&
                   (ret = plugins["processPackage"].normalizeMapping(key, to))) {
                    key = ret.key;
                    to = ret.to;
                    id = ret.id;
                    info = ret.info;
                } else if(typeof to == "string"){
					if(to.substring(0,5) == "http:"){
						to = "jar:" + to + "!/lib/";
					}
					// if it ends with a slash, only match paths
					if(to.charAt(to.length - 1) === '/' && key.charAt(key.length - 1) !== '/'){
						key += '/';
					}
					// for backwards compatibility with regex exact matches
					else if(key.charAt(0) === "^" && key.charAt(key.length - 1) === "$"){
						to += packageData.extension || ".js";
						key = key.substring(1, key.length - 1);
					}
                }else if(to.archive){
                    var libDir = to.descriptor && to.descriptor.directories && to.descriptor.directories.lib;
                    if(typeof libDir != "string"){
                        libDir = "lib";
                    }
                    key += '/';
                    to = to.archive ? "jar:" + to.archive + "!/" + libDir + "/" : to.location;
                }else if(to.location){
                    if(to.location.substring(to.location.length-1)!="/") {
                        throw new Error("mapping location for '" + key + "' must end in '/' in package '" + packageUri + "'");
                    }
                    // always match paths
                    key += '/';
                    var libDir = to.descriptor && to.descriptor.directories && to.descriptor.directories.lib;
                    if(typeof libDir != "string"){
                        libDir = "lib";
                    }
                    to = to.location.substring(0, to.location.length-1) + "!/" + libDir + "/";
                }
				return {
					from: key,
					exact: to.match(/\.\w+$/),
					to: resolveUri(packageUri, typeof to == "string" ? to : to.to),
                    id: id,
                    info: info
				};
			}).sort(function(a, b){
				return a.from.toString().length < b.from.toString().length ? 1 : -1;
			}));
		}
	}
	if(packageData.overlay){
		Object.keys(packageData.overlay).forEach(function(condition){
			try{
				var matches = (engine == condition) || !(condition in allKnownOverlays) && eval(condition);
			}catch(e){}
			if(matches){
				addMappings(packageData.overlay[condition].mappings);
			}
		});
	}
	addMappings(packageData.mappings);
	mappingsArray.defaultPath = defaultPath; 
	packageData.mappings = mappingsArray;
    if(debug) print("[nodules][processPackage] packageData.mappings: ");
    if(debug) dump(packageData.mappings);
	return packageData;
}



exports.load = function(uri, require){
    if(debug) print("[nodules][load] uri: " + uri);
    var protocolLoader = false,
        ret;
    if(plugins["loader"] && plugins["loader"].getForUri &&
       (ret = plugins["loader"].getForUri(uri))) {
        protocolLoader = ret;
    } else {
        protocolLoader = exports.protocols[uri.substring(0, uri.indexOf(":"))];
    }
	// do this so that we don't timeout on adding the error handler for the source
	if(!protocolLoader){
		throw new Error("Protocol " + uri.substring(0, uri.indexOf(":")) + " not implemented for accessing " + uri);
	}
	var source = protocolLoader(uri);
	return when(source, function(source){
		if(!source){
			throw new Error("Not found");
		}
		var packageUri = getPackageUri(uri, source);
        if(debug) print("[nodules][load] packageUri: " + packageUri);
		var packageData = packages[packageUri];
		if(!packageData){
	//			idPart = uri;
	//		function tryNext(){
		//		idPart = idPart.substring(0, idPart.lastIndexOf('/') + 1);
			// don't watch json files or changes will create a new factory
            dontWatch[packageUri + "package.json"] = true;
            dontWatch[packageUri + "package.local.json"] = true;
			packageData = when(protocolLoader(packageUri + "package.json"), function(packageJson){
				if(!packageJson){
					return packages[packageUri] = processPackage(packageUri, {});
				}
                var parsed;
				try{
                    parsed = JSON.parse(packageJson);
				}catch(e){
					e.message += " trying to parse " + packageUri + "package.json";
					throw e;
				}
                return when(protocolLoader(packageUri + "package.local.json"), function(packageJson){
                    if(!packageJson){
                        return packages[packageUri] = processPackage(packageUri, parsed);
                    }
                    var parsedLocal;
                    try{
                        parsedLocal = JSON.parse(packageJson);
                    }catch(e){
                        e.message += " trying to parse " + packageUri + "package.local.json";
                        throw e;
                    }
                    deepUpdate(parsed, parsedLocal);
                    return packages[packageUri] = processPackage(packageUri, parsed);
                }, function(error){
                    return packages[packageUri] = processPackage(packageUri, parsed);
                });
			}, function(error){
				return packages[packageUri] = processPackage(packageUri, {});
			});
			if(!packages[packageUri]){
				packages[packageUri] = packageData;
			} 
		}
		return when(packageData, function(packageData){
			if(source){
				source.replace(/[\s;=\(]require\s*\(\s*['"]([^'"]*)['"]\s*\)/g, function(t, moduleId){
					if(require){
						require.ensure(moduleId);
					}
				});
				source.replace(/define\s*\(\s*(\[(?:['"][^'"]*['"],?)+\])\s*\)/, function(t, deps){
					deps = JSON.parse(deps);
					if(require){
						deps.forEach(function(moduleId){
							require.ensure(moduleId);
						});
					}
				});
				
				if(packageData.compiler){
					require.ensure(packageData.compiler.module);
				}
			}
			return source;
		});
	});
};
function createFactory(uri, source){
	try{
        var lineOffset = 0;
        try {
            throw new Error("line");
        } catch(e) {
            // gecko
            lineOffset = e.lineNumber || "";
        }
        lineOffset += 5;
		factories[uri] = compile("function(require, exports, module, define, __filename, __dirname, Worker, SharedWorker){" + source + "\n;return exports;}", uri);
/*		var indexOfExport, indexOfRequireDef = source.indexOf("define");
		if(indexOfRequireDef > -1 && ((indexOfExport = source.indexOf("exports.")) == -1 || indexOfExport > indexOfRequireDef)){
			// looks like it is an Aynchronous module definition module
			factories[uri]({def: function(id, dependencies, factory){
				if(!factory){
					factory = dependencies;
					if(!factory){
						factory = id;
						id = null;
					}
					dependencies = null;
					
				}
				if(typeof id == "object"){
					dependencies = id;
					id = null;
				}
				if(typeof id == "string"){
					if(uri.indexOf(id) == -1){
						throw new Error("Can't set another module");
					}
				}
				if(dependencies){
					makeRequire(uri).ensure(dependencies.filter(function(dep){
						return !(dep in {require:true, exports:true, module: true});
					}));
				}
				factories[uri] = function(require, exports, module){
					return factory.apply(exports, dependencies ? dependencies.map(function(id){
						switch(id){
							case "require": return require;
							case "exports" : return exports;
							case "module" : return module;
							default: return require(id);
						}
					}) : arguments);
				};
			}});
		}*/
	}catch(e){
        if(plugins["createFactory"] && plugins["createFactory"].onError) {
            plugins["createFactory"].onError({
                "message": e.message,
                "file": uri,
                "line": (e.lineNumber - lineOffset),
                "source": source
            });
        }
		factories[uri] = function(){
			throw new Error(e.stack + " in " + uri);
		}
	}
}
exports.protocols = {
	http: cache(function(uri){
		return getUri(uri);
	}, true),
	jar: cache(function(uri){
		uri = uri.substring(4);
		var exclamationIndex = uri.indexOf("!");
		var target = uri.substring(exclamationIndex + 2);
		var targetContents;
		uri = uri.substring(0, exclamationIndex);
		return when(fs.stat(cachePath(uri)), function(stat){
			if(!stat.mtime){
				return onError();
			}
			// archive has already been downloaded, but the file was not found
			return null;
		}, onError);
		function onError(){
			return when(getUri(uri), function(source){
				if(source === null){
					throw new Error("Archive not found " + uri);
				}
				var unzip = new Unzip(source);
				unzip.readEntries();
				var rootPath = unzip.entries[0].fileName;
				unzip.entries.some(function(entry){
					if(target == entry.fileName){
						rootPath = "";
						return true;
					}
					if(entry.fileName.substring(0, rootPath.length) !== rootPath){
						rootPath = "";
					}
				});
				unzip.entries.forEach(function(entry){
					var fileName = entry.fileName.substring(rootPath.length); 
					var path = cachePath(uri + "!/" + fileName);
					if (entry.compressionMethod <= 1) {
						// Uncompressed
						var contents = entry.data; 
					} else if (entry.compressionMethod === 8) {
						// Deflated
						var contents = zipInflate(entry.data);
					}else{
						throw new Error("Unknown compression format");
					}
					ensurePath(path);
					if(path.charAt(path.length-1) != '/'){
						// its a file
						try{
							fs.writeFileSync(path, contents, "binary");
						}catch(e){
							 // make sure we immediately let the user know if a write fails
							throw e;
						}
					}
					if(target == fileName){
						targetContents = contents;
					}
				});
				if(!targetContents){
					throw new Error("Target path " + target + " not found in archive " + uri);
				}
				return targetContents;
			});
		}
	}),
	file: function(uri){
        var path = uri.substring(7);
        var exclamationIndex = path.indexOf("!/");
        if(exclamationIndex>0) {
            path = path.substring(0, exclamationIndex) + path.substring(exclamationIndex+1);
        }
		return readModuleFile(path, uri);
	},
	data: function(uri){
		return uri.substring(uri.indexOf(","));
	}
};
exports.protocols.zip = exports.protocols.jar;

var requestedUris = {};
function getUri(uri, tries){
	tries = tries || 1;
	if(requestedUris[uri]){
		return requestedUris[uri];
	}
	print("Downloading " + uri + (tries > 1 ? " attempt #" + tries : ""));
	return requestedUris[uri] = request({url:uri, encoding:"binary"}).then(function(response){
		if(response.status == 302){
			return getUri(response.headers.location);
		}
		if(response.status < 300){
			var body = "";
			return when(response.body.forEach(function(part){
				if(!body){
					body = part;
				}else{
					body += part;
				}
			}), function(){
				return body;
			});
		}
		if(response.status == 404){
			return null;
		}
		throw new Error(response.status + response.body);
	}, function(error){
		tries++;
		if(tries > 3){
			throw error;
		}
		// try again
		delete requestedUris[uri];
		return getUri(uri, tries);
	});
}

function onFileChange(uri){
	// we delete all module entries and dependents to ensure proper referencing
	function removeDependents(module){
		if(module){
			delete moduleExports[module.id];
			var dependents = module.dependents; 
			module.dependents = {};
			for(var i in dependents){
				removeDependents(modules[i]);
			}
		}
	}
	removeDependents(modules[uri]);
	var calling = monitored;
	monitored = [];
	calling.forEach(function(callback){
		callback();
	});
}
function ensurePath(path){
	var index = path.lastIndexOf('/');
	if(index === -1){
		return;
	}
	var path = path.substring(0, index);
	try{
		var test = fs.statSync(path).mtime.time;
	}catch(e){
		ensurePath(path);
		fs.mkdirSync(path, 0777);
	}
}
var watching = {};
var dontWatch = {};

var watchedFiles;
function readModuleFile(path, uri){
    if(debug) print("[nodules][readModuleFile] path: " + path);
    if(debug) print("[nodules][readModuleFile] uri: " + uri);
	try{
        if(!fs.exists(path)) return null;
		var source = fs.read(path);
		if(monitorModules && !watching[path] && !dontWatch[uri]){
			watching[path] = true;
			if(fs.watchFile && !useSetInterval){
				fs.watchFile(path, {persistent: false, interval: process.platform == "darwin" ? 300 : 0}, possibleChange);
			}else{
				if(!watchedFiles){
					watchedFiles = [];
					schedule(1000).forEach(function(){
						watchedFiles.forEach(function(watched){
							if(!watched.pending){
								watched.pending = true;
								// a hack to get the OS to reread from the network paths
								if(fs.closeSync){
									fs.closeSync(fs.openSync(watched.path, "r"));
								}
								when(fs.stat(watched.path), function(stat){
									watched.pending = false;
									watched.callback(watched.oldstat, stat);
									watched.oldstat = stat;
								}, print);
							}
						});
					});
				}
				watchedFiles.push({
					oldstat: fs.statSync(path),
					path: path,
					callback: possibleChange
				});
			}
		}
		return source;
	}
	catch(e){
        if(debug) print("[nodules][readModuleFile] ERROR: " + e.message + " => " + e.stack);
		if(path.match(/\.js$/) && typeof process != "undefined"){
			path = path.replace(/\.js$/,".node");
			try{
				fs.read(path);
				return 'process.dlopen("' + path + '", exports);'; 
			}
			catch(nodeE){
			}
		}
		throw e;
	}
	function possibleChange(oldstat, newstat){
		if(oldstat.mtime.getTime() !== newstat.mtime.getTime() && waitingOn === 0){
			if(typeof process == "undefined" || !process.env._CHILD_ID_){
				print("Reloading " + uri);
			}
			delete factories[uri];
			exports.ensure(uri, function(){
				onFileChange(uri);
			});
		}
	}
}
function cachePath(uri){
	var path = uri;
	if(path.indexOf(exports.defaultUri) === 0){
		path = path.substring(exports.defaultUri.length);
	}
	filePathMappings.forEach(function(pathMapping){
		path = path.replace(pathMapping.from, pathMapping.to);
	});
	return ((path.charAt(0) == '/' || path.charAt(1) == ':' || path.substring(0,5) == "file:") ? '' : exports.baseFilePath + '/') + path.replace(/^\w*:(\w*:)?\/\//,'').replace(/!\/?/g,'/'); // remove protocol and replace colons and add base file path
}
function cache(handler, writeBack){
	return function(uri){
		try{
			return when(readModuleFile(cachePath(uri), uri), function(source){
				if(source === "Not Found"){
					return null;
				}
				return source;
			}, onError);
		}
		catch(e){
			return onError(e);
		}
		function onError(error){
			var source = handler(uri);
			if(writeBack){
				when(source, function(source){
					var path = cachePath(uri);
					ensurePath(path);
					fs.writeFileSync(path, source === null ? "Not Found" : source, "binary");
				});
			}
			return source;
		}
	};
};

function deepUpdate(target, source) {
    var key;
    for (key in source) {
        if(Object.prototype.hasOwnProperty.call(source, key)) {
            if(typeof source[key] == "object" && Object.prototype.hasOwnProperty.call(target, key) &&
               typeof target[key] == "object" && !Array.isArray(target[key])) {
                deepUpdate(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }
};

} // newInstance()


exports.newInstance(exports, {
    "debug": system.env.NODULES_DEBUG,
    "path": system.env.NODULES_PATH,
    "sync": system.env.NODULES_SYNC,
    "pathMappings": system.env.NODULES_PATH_MAPPINGS
});


if(typeof process == "undefined"){
	system.args.unshift(null);
}
if(require.main == module){
	if (system.args[2] === "-refresh") {
		print("deleting " + exports.baseFilePath);
 		require("child_process").exec("rm -r " + exports.baseFilePath, function(err, stdout, stderr) {
		if (err !== null) {
			system.print("error deleting directory: " + err);
		} else {
			exports.useLocal().runAsMain(system.args[3]);
		}
	});
	} else {
 		exports.useLocal().runAsMain(system.args[2]);
	}
	if(typeof process === "undefined"){
		require("event-loop").enterEventLoop();
	}
}
})(this);
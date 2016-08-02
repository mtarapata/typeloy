var cjson = require('cjson');
var path = require('path');
var fs = require('fs');
var format = require('util').format;

import _ = require('underscore');
import 'colors';

interface Env {
  [key:string]: string
}

interface SshOptions {
  agent?: string;
  port?: number;
}


interface SiteConfig {
  servers : Array<ServerConfig>;
}


interface SiteTableConfig {
  [name:string] : SiteConfig;
}

interface ServerConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  app?: string;
  os?: string;
  pem?: string;
  env: Env;
  sshOptions: SshOptions;
}

interface SslConfig {
  backendPort: number;
  pem: string;
}


interface SetupConfig {
  node: boolean|string;
  phantom: boolean;
  mongo: boolean;
}

export interface Config {
  setup?: SetupConfig;

  // legacy setup config
  setupNode: boolean;
  setupPhantom: boolean;
  setupMongo: boolean;
  nodeVersion?: string;

  enableUploadProgressBar: boolean;
  appName: string;
  env: Env;
  meteorBinary?: string;
  servers: Array<ServerConfig>;
  app: string;
  ssl?: SslConfig;
  deployCheckWaitTime?: number;
  plugins: Array<any>;
}



function expandPath(loc:string) : string {
  if (/^win/.test(process.platform)) {
    return loc.replace('~', process.env.USERPROFILE);
  }
  return loc.replace('~', process.env.HOME);
}

function fatal(message:string) {
  var errorMessage = 'Invalid json config file: ' + message;
  console.error(errorMessage);
  process.exit(1);
}

function canonicalizePath(loc:string) : string {
  var localDir : string = path.resolve(__dirname, loc);
  if (fs.existsSync(localDir)) {
    return localDir;
  }
  return path.resolve(expandPath(loc));
}

export class ConfigParser {

  public static parse(configPath:string) : Config {
    var config:Config;
    if (configPath.match(/\.json$/)) {
      config = cjson.load(configPath);
    } else if (configPath.match(/\.js$/)) {
      config = require(configPath);
    } else {
      // fallback to json parsing
      config = cjson.load(configPath);
    }
    config = this.preprocess(config);
    this.validate(config);
    return config;
  }

  public static convertLegacyConfig(config:Config) : Config {
    // Convert legacy setup configs to new SetupConfig
    if (typeof config.setupNode !== "undefined") {
      config.setup.node = config.nodeVersion || true;
    }
    if (typeof config.setupPhantom !== "undefined") {
      config.setup.phantom = true;
    }
    if (typeof config.setupMongo !== "undefined") {
      config.setup.mongo = true;
    }
    return config;
  }

  public static preprocess(config:Config) : Config {
    config.env = config.env || {};
    config.setup = config.setup || {} as SetupConfig;

    config = this.convertLegacyConfig(config);

    config.meteorBinary = (config.meteorBinary) ? canonicalizePath(config.meteorBinary) : 'meteor';
    if (typeof config.appName === "undefined") {
      config.appName = "meteor";
    }
    if (typeof config.enableUploadProgressBar === "undefined") {
      config.enableUploadProgressBar = true;
    }
    
    _.each(config.servers, (server:ServerConfig) => {
      let sshAgentExists = false;
      let sshAgent:string = process.env.SSH_AUTH_SOCK;
      if (sshAgent) {
        sshAgentExists = fs.existsSync(sshAgent);
        server.sshOptions = server.sshOptions || {};
        server.sshOptions.agent = sshAgent;
      }
      server.os = server.os || "linux";
      if (server.pem) {
        server.pem = expandPath(server.pem);
      }

      server.env = server.env || {};
      var defaultEndpointUrl : string =
        format("http://%s:%s", server.host, config.env['PORT'] || 80);
      server.env['CLUSTER_ENDPOINT_URL'] =
        server.env['CLUSTER_ENDPOINT_URL'] || defaultEndpointUrl;
    });

    // rewrite ~ with $HOME
    config.app = expandPath(config.app);
    if (config.ssl) {
      config.ssl.backendPort = config.ssl.backendPort || 80;
      config.ssl.pem = path.resolve(expandPath(config.ssl.pem));
    }
    return config;
  }

  public static validate(config:Config) {

    function validateServerConfig(server:ServerConfig, sshAgentExists: boolean) : boolean {
      if (!server.host) {
        fatal('Server host does not exist');
      }
      if (!server.username) {
        fatal('Server username does not exist');
      }
      if (!server.password && !server.pem && !sshAgentExists) {
        fatal('Server password, pem or a ssh agent does not exist');
      }
      return true;
    }

    // validating server config
    if (typeof config.servers === "undefined") {
      fatal("Config 'servers' is not defined.");
    }
    if (config.servers instanceof Array && config.servers.length == 0) {
      fatal("Config 'servers' is empty.");
    }

    _.each(config.servers, (server:ServerConfig) => {
      var sshAgentExists:boolean = false;
      var sshAgent:string = process.env.SSH_AUTH_SOCK;
      if (sshAgent) {
        sshAgentExists = fs.existsSync(sshAgent);
      }
      validateServerConfig(server, sshAgentExists);
    });
    if (!config.app) {
      fatal('Path to app does not exist');
    }
    if (config.ssl) {
      if (!fs.existsSync(config.ssl.pem)) {
        fatal('SSL pem file does not exist');
      }
    }
  }
}

export function readConfig(configPath:string) : Config {
  if (configPath) {
    let filepath : string = path.resolve(configPath);
    if (fs.existsSync(filepath)) {
      return ConfigParser.parse(filepath);
    }
  }
  let possibleConfigFiles:Array<string> = ['typeloy.js', 'typeloy.json', 'typeloy.config.json', 'mup.json'];
  for (var i = 0; i < possibleConfigFiles.length ; i++) {
    let fn = possibleConfigFiles[i];
    let filepath : string = path.resolve(fn);
    if (fs.existsSync(filepath)) {
      return ConfigParser.parse(filepath);
    }
  }
  console.error('config file does not exist! possible config filenames: [' + possibleConfigFiles.join(',') + ']');
  // helpers.printHelp();
  process.exit(1);
};


var nodemiral = require('nodemiral');
import path = require('path');
import fs = require('fs');
var rimraf = require('rimraf');
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var uuid = require('uuid');
var format = require('util').format;
var extend = require('util')._extend;
var async = require('async');

import {Config} from './config';
import LinuxTasks from "./taskLists/linux";
import SunosTasks from "./taskLists/sunos";
import Deployment from './deployment';
import {CmdDeployOptions} from './options';
import {Plugin, PluginRunner, SlackNotificationPlugin} from './plugins';

import _ = require('underscore');
import {buildApp} from './build';

var os = require('os');
require('colors');

/*
Session {
  _host: '161.202.108.119',
  _auth: { username: 'root', password: 'SmQUld3z' },
  _options:
   { ssh: { agent: '/tmp/ssh-RcgKVIGk8tfL/agent.4345' },
     keepAlive: true },
  _keepAlive: true,
  _tasks: [],
  _callbacks: [],
  _debug: { [Function: disabled] enabled: false },
  _serverConfig:
   { host: '161.202.108.119',
     username: 'root',
     password: 'SmQUld3z',
     env:
      { ROOT_URL: 'http://staging.kaneoh.com',
        CLUSTER_ENDPOINT_URL: 'http://161.202.108.119:80' },
     sshOptions: { agent: '/tmp/ssh-RcgKVIGk8tfL/agent.4345' },
     os: 'linux' } }
*/
interface Session {
  copy(src, dest, options, callback)
  execute(shellCommand, options, callback)
  executeScript(scriptFile, options, callback)
  close()
}


const kadiraRegex = /^meteorhacks:kadira/m;

function storeLastNChars(vars, field, limit, color) {
  return function(data) {
    vars[field] += data.toString();
    if(vars[field].length > 1000) {
      vars[field] = vars[field].substring(vars[field].length - 1000);
    }
  };
}



function haveSummaryMapsErrors(summaryMaps) {
  return _.some(summaryMaps, hasSummaryMapErrors);
}

function hasSummaryMapErrors(summaryMap) {
  return _.some(summaryMap, (summary:any) => {
    return summary.error;
  });
}

export default class Actions {

  public cwd:string;

  public config:Config;

  public sessionsMap;

  protected pluginRunner:PluginRunner;

  constructor(config:Config, cwd:string) {
    this.cwd = cwd;
    this.config = config;
    this.sessionsMap = this._createSessionsMap(config);

    this.pluginRunner = new PluginRunner(config, cwd);

    // Get settings.json into env,
    // The METEOR_SETTINGS can be used for setting up meteor application without passing "--settings=...."
    //
    // Here is the guide of using METEOR_SETTINGS
    // https://themeteorchef.com/snippets/making-use-of-settings-json/#tmc-using-settingsjson
    //
    // @see http://joshowens.me/environment-settings-and-security-with-meteor-js/
    var setttingsJsonPath = path.resolve(this.cwd, 'settings.json');
    if (fs.existsSync(setttingsJsonPath)) {
      this.config.env['METEOR_SETTINGS'] = JSON.stringify(require(setttingsJsonPath));
    }
  }



  /**
  * @param {object} config (the mup config object)
  */
  private _createSessionsMap(config:Config) {
    var sessionsMap = {};

    config.servers.forEach((server) => {
      var host = server.host;
      var auth:any = { username: server.username };

      if(server.pem) {
        auth.pem = fs.readFileSync(path.resolve(server.pem), 'utf8');
      } else {
        auth.password = server.password;
      }

      var nodemiralOptions = {
        ssh: server.sshOptions,
        keepAlive: true
      };

      // Create os => taskListBuilder map
      if (!sessionsMap[server.os]) {
        switch (server.os) {
          case "linux":
            sessionsMap[server.os] = {
              sessions: [],
              taskListsBuilder: LinuxTasks
            };
            break;
          case "sunos":
            sessionsMap[server.os] = {
              sessions: [],
              taskListsBuilder: SunosTasks
            };
            break;
        }
      }

      var session = nodemiral.session(host, auth, nodemiralOptions);
      session._serverConfig = server;
      sessionsMap[server.os].sessions.push(session);
    });

    return sessionsMap;
  }

  private _showKadiraLink() {
    var versionsFile = path.join(this.config.app, '.meteor/versions');
    if (fs.existsSync(versionsFile)) {
      var packages = fs.readFileSync(versionsFile, 'utf-8');
      var hasKadira = kadiraRegex.test(packages);
      if(!hasKadira) {
        console.log(
          "“ Checkout " + "Kadira" + "!"+
          "\n  It's the best way to monitor performance of your app."+
          "\n  Visit: " + "https://kadira.io/mup" + " ”\n"
        );
      }
    }
  }

  private _executePararell(actionName:string, deployment, args) {
    var self = this;
    var sessionInfoList = _.values(self.sessionsMap);
    async.map(
      sessionInfoList,
      // callback: the trigger method
      (sessionsInfo, callback) => {
        var taskList = sessionsInfo.taskListsBuilder[actionName]
          .apply(sessionsInfo.taskListsBuilder, args);
        taskList.run(sessionsInfo.sessions, function(summaryMap) {
          callback(deployment, null, summaryMap);
        });
      },
      this.whenAfterCompleted
    );
  }

  public setup(deployment) {
    this._showKadiraLink();
    this._executePararell("setup", deployment, [this.config]);
  }

  public deploy(deployment:Deployment, sites:Array<string>, options:CmdDeployOptions) {
    var self = this;
    self._showKadiraLink();

    const getDefaultBuildDirName = function(appName:string, tag:string) : string {
      return (appName || "meteor-") + "-" + (tag || uuid.v4());
    };

    const buildLocation = process.env.METEOR_BUILD_DIR || path.resolve(os.tmpdir(), getDefaultBuildDirName(this.config.appName, deployment.tag));
    const bundlePath = options.bundleFile || path.resolve(buildLocation, 'bundle.tar.gz');

    console.log('Deployment Tag:', deployment.tag);
    console.log('Build Location:', buildLocation);
    console.log('Bundle Path:', bundlePath);

    // spawn inherits env vars from process.env
    // so we can simply set them like this
    process.env.BUILD_LOCATION = buildLocation;

    var deployCheckWaitTime = this.config.deployCheckWaitTime || this.config.deploy.checkDelay;
    var appName = this.config.appName;
    var appPath = this.config.app;
    var enableUploadProgressBar = this.config.enableUploadProgressBar;
    var meteorBinary = this.config.meteorBinary;

    console.log('Meteor Path: ' + meteorBinary);
    console.log('Building Started: ' + this.config.app);


    buildApp(appPath, meteorBinary, buildLocation, bundlePath, () => {
      this.whenBeforeBuilding(deployment);
    } , (err) => {
      if (err) {
        process.exit(1);
        return;
      }
      var sessionsData = [];
      _.forEach(self.sessionsMap, (sessionsInfo:any) => {
        var taskListsBuilder = sessionsInfo.taskListsBuilder;
        _.forEach(sessionsInfo.sessions, (session) => {
          sessionsData.push({
            taskListsBuilder: taskListsBuilder,
            session: session
          });
        });
      });

      // We only want to fire once for now.
      this.whenBeforeDeploying(deployment);

      async.mapSeries(
        sessionsData,
        (sessionData, callback) => {
          var session = sessionData.session;
          var taskListsBuilder = sessionData.taskListsBuilder;
          var env = _.extend({}, this.config.env, session._serverConfig.env);

          // Build deploy tasks
          var taskList = taskListsBuilder.deploy(
                          bundlePath, env,
                          deployCheckWaitTime, appName, enableUploadProgressBar);
          taskList.run(session, function (summaryMap) {
            callback(null, summaryMap);
          });
        },
        // When all deployment was done, this method will be triggered.
        this.whenAfterDeployed(deployment, buildLocation, options)
      );
    });
  }

  public reconfig(deployment: Deployment) {
    var self = this;
    var sessionInfoList = [];
    for (var os in this.sessionsMap) {
      var sessionsInfo = this.sessionsMap[os];
      sessionsInfo.sessions.forEach((session) => {
        var env = _.extend({}, this.config.env, session._serverConfig.env);
        var taskList = sessionsInfo.taskListsBuilder.reconfig(env, this.config.appName);
        sessionInfoList.push({
          taskList: taskList,
          session: session
        });
      });
    }

    async.mapSeries(
      sessionInfoList,
      (sessionInfo, callback) => {
        sessionInfo.taskList.run(sessionInfo.session, function(summaryMap) {
          callback(deployment, null, summaryMap);
        });
      },
      this.whenAfterCompleted
    );
  }

  public restart(deployment: Deployment) {
    this._executePararell("restart", deployment, [this.config.appName]);
  }

  public stop(deployment: Deployment) {
    this._executePararell("stop", deployment, [this.config.appName]);
  };

  public start(deployment: Deployment) {
    this._executePararell("start", deployment, [this.config.appName]);
  }

  public logs(options) {
    var self = this;
    var tailOptions = [];
    if (options.tail) {
      tailOptions.push('-f');
    }
    for (var os in self.sessionsMap) {
      var sessionsInfo = self.sessionsMap[os];
      sessionsInfo.sessions.forEach(function(session) {
        var hostPrefix = '[' + session._host + '] ';
        var opts = {
          onStdout: function(data) {
            process.stdout.write(hostPrefix + data.toString());
          },
          onStderr: function(data) {
            process.stderr.write(hostPrefix + data.toString());
          }
        };

        if(os == 'linux') {
          var command = 'sudo tail ' + tailOptions.join(' ') + ' /var/log/upstart/' + self.config.appName + '.log';
        } else if(os == 'sunos') {
          var command = 'sudo tail ' + tailOptions.join(' ') +
            ' /var/svc/log/site-' + self.config.appName + '\\:default.log';
        }
        session.execute(command, opts);
      });
    }
  }

  public init() {
    var destMupJson = path.resolve('mup.json');
    var destSettingsJson = path.resolve('settings.json');

    if(fs.existsSync(destMupJson) || fs.existsSync(destSettingsJson)) {
      console.error('A Project Already Exists');
      process.exit(1);
    }

    var exampleMupJson = path.resolve(__dirname, '../example/mup.json');
    var exampleSettingsJson = path.resolve(__dirname, '../example/settings.json');

    copyFile(exampleMupJson, destMupJson);
    copyFile(exampleSettingsJson, destSettingsJson);

    console.log('Empty Project Initialized!');

    function copyFile(src, dest) {
      var content = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(dest, content);
    }
  }

  whenBeforeBuilding(deployment : Deployment) {
    this.pluginRunner.whenBeforeBuilding(deployment);
  }

  whenBeforeDeploying(deployment : Deployment) {
    this.pluginRunner.whenBeforeDeploying(deployment);
  }

  /**
  * After completed ....
  *
  * Right now we don't have things to do, just exit the process with the error
  * code.
  */
  async whenAfterCompleted(deployment : Deployment, error, summaryMaps) {
    this.pluginRunner.whenAfterCompleted(deployment);
    var errorCode = error || haveSummaryMapsErrors(summaryMaps) ? 1 : 0;
    if (errorCode != 0) {
      await this.whenFailure(deployment, error, summaryMaps);
    } else {
      await this.whenSuccess(deployment, error, summaryMaps);
    }
    process.exit(errorCode);
  }

  public async whenSuccess(deployment : Deployment, error, summaryMaps) {
    let promise = this.pluginRunner.whenSuccess(deployment);
    await promise;
  }

  public async whenFailure(deployment : Deployment, error, summaryMaps) {
    let promise = this.pluginRunner.whenFailure(deployment);
    await promise;
  }

  /**
   * Return a callback, which is used when after deployed, clean up the files.
   */
  whenAfterDeployed(deployment : Deployment, buildLocation:string, options:CmdDeployOptions) {
    return (error, summaryMaps) => {
      this.pluginRunner.whenAfterDeployed(deployment);
      if (options.clean) {
        console.log(`Cleaning up ${buildLocation}`);
        rimraf.sync(buildLocation);
      }
      return this.whenAfterCompleted(deployment, error, summaryMaps);
    };
  }
}


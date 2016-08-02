#!/bin/bash
DEPLOY_PREFIX="<%= deployPrefix %>"
APP_NAME="<%= appName %>"
APP_ROOT=$DEPLOY_PREFIX/$APP_NAME
TMP_DIR=$DEPLOY_PREFIX/$APP_NAME/tmp
BUNDLE_DIR=$TMP_DIR/bundle
BUNDLE_TARBALL_FILE=bundle.tar.gz
DEPLOY_CHECK_WAIT_TIME=<%= deployCheckWaitTime %>

# utilities
gyp_rebuild_inside_node_modules () {
  for npmModule in ./*; do
    cd $npmModule

    isBinaryModule="no"
    # recursively rebuild npm modules inside node_modules
    check_for_binary_modules () {
      if [ -f binding.gyp ]; then
        isBinaryModule="yes"
      fi

      if [ $isBinaryModule != "yes" ]; then
        if [ -d ./node_modules ]; then
          cd ./node_modules
          for module in ./*; do
            (cd $module && check_for_binary_modules)
          done
          cd ../
        fi
      fi
    }

    check_for_binary_modules

    if [ $isBinaryModule = "yes" ]; then
      echo " > $npmModule: npm install due to binary npm modules"
      rm -rf node_modules
      if [ -f binding.gyp ]; then
        sudo npm install --update-binary
        sudo node-gyp rebuild || :
      else
        sudo npm install --update-binary
      fi
    fi

    cd ..
  done
}

rebuild_binary_npm_modules () {
  for package in ./*; do
    if [ -d $package/node_modules ]; then
      (cd $package/node_modules && \
        gyp_rebuild_inside_node_modules)
    elif [ -d $package/main/node_module ]; then
      (cd $package/node_modules && \
        gyp_rebuild_inside_node_modules )
    fi
  done
}

revert_app () {
  if [[ -d old_app ]]; then
    sudo rm -rf app
    sudo mv old_app app
    sudo stop <%= appName %> || :
    sudo start <%= appName %> || :
    echo "Latest deployment failed! Reverted back to the previous version." 1>&2
    exit 1
  else
    echo "App did not pick up! Please check app logs." 1>&2
    exit 1
  fi
}

# logic
set -e
set -o xtrace



cd ${TMP_DIR}
echo "Removing bundle..."
sudo rm -rf $TMP_DIR/bundle

echo "Extracing $TMP_DIR/$BUNDLE_TARBALL_FILE"
sudo tar xvzf $BUNDLE_TARBALL_FILE > /dev/null

# why are we adding execute mode?
sudo chmod -R +x *
sudo chown -R ${USER} ${BUNDLE_DIR}

# rebuilding fibers
cd ${BUNDLE_DIR}/programs/server

if [ -d npm ]; then
  (cd npm && rebuild_binary_npm_modules)
fi

if [ -d node_modules ]; then
  (cd node_modules && gyp_rebuild_inside_node_modules)
fi

# Special fix for bcrypt invalid ELF issue
# @see http://stackoverflow.com/questions/27984456/deploying-meteor-app-from-os-x-to-linux-causes-bcrypt-issues
# @see https://github.com/meteor/meteor/issues/7513

# for 1.3 
if [[ -e npm/node_modules/meteor/npm-bcrypt/node_modules/bcrypt ]] ; then
    rm -rf npm/node_modules/meteor/npm-bcrypt/node_modules/bcrypt
    npm install --update-binary -f bcrypt
    cp -r node_modules/bcrypt npm/node_modules/meteor/npm-bcrypt/node_modules/bcrypt
fi
if [[ -e npm/node_modules/bignum ]] ; then
    rm -rf npm/node_modules/bignum
    npm install --update-binary -f bignum
    cp -r node_modules/bignum npm/node_modules/bignum
fi
if [[ -e npm/npm-container/node_modules/nsq.js/node_modules/bignum ]] ; then
    # for meteor 1.2, we have npm-container
    rm -rf npm/npm-container/node_modules/nsq.js/node_modules/bignum
    npm install --update-binary -f bignum
    cp -r node_modules/bignum npm/npm-container/node_modules/nsq.js/node_modules/bignum
fi
if [[ -e npm/node_modules/nsq.js/node_modules/bignum ]] ; then
    # for meteor 1.3, we have bignum used in nsq.js
    rm -rf npm/node_modules/nsq.js/node_modules/bignum
    npm install --update-binary -f bignum
    cp -r node_modules/bignum npm/node_modules/nsq.js/node_modules/bignum
fi

if [ -f package.json ]; then
  echo "Found package.json, running npm install ..."
  # support for 0.9
  sudo npm install
else
  # support for older versions
  sudo npm install fibers
  sudo npm install bcrypt
fi

cd $APP_ROOT

# remove old app, if it exists
if [ -d old_app ]; then
  sudo rm -rf old_app
fi

## backup current version
if [[ -d app ]]; then
  sudo mv app old_app
fi

sudo mv tmp/bundle app

#wait and check
echo "Waiting for MongoDB to initialize. (5 minutes)"
. $APP_ROOT/config/env.sh
wait-for-mongo $MONGO_URL 300000

# restart app
echo "Restarting the app"
sudo stop $APP_NAME || :
sudo start $APP_NAME || :

echo "Waiting for $DEPLOY_CHECK_WAIT_TIME seconds while app is booting up"
sleep $DEPLOY_CHECK_WAIT_TIME

echo "Checking is app booted or not?"
curl localhost:${PORT} || revert_app

# chown to support dumping heapdump and etc
sudo chown -R meteoruser app

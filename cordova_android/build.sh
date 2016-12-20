#!/bin/bash

NORMAL_COLOR='\033[0m'
RED_COLOR='\033[0;31m'
GREEN_COLOR='\033[0;32m'
GRAY_COLOR='\033[0;37m'

LOG() {
  COLOR="$1"
  TEXT="$2"
  echo -e "${COLOR}$TEXT ${NORMAL_COLOR}"
}

if [ ! $# -eq 2 ]
  then
  LOG $RED_COLOR "usage: ./build.sh <ndk_path> <path_to_binaries>\n"
  exit
fi

ANDROID_NDK=$1
PATH_TO_BINARIES=$2

pushd ${PWD}/cordova_android
  rm -rf jxcore-binaries/
  mkdir jxcore-binaries/
  cp -R ${PATH_TO_BINARIES}/* jxcore-binaries/

  ${ANDROID_NDK}/ndk-build

  rm -rf jxcore-binaries/
  rm -rf obj/
popd

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

if [ $# -eq 0 ]
then
  LOG $RED_COLOR "no argument provided."
  LOG $GREEN_COLOR "usage: android_compile_v8 <ndk_path>\n"
  exit
fi

ANDROID_NDK=$1
DIR=${PWD}

bash ${DIR}/build_scripts/android-configure.sh ${ANDROID_NDK}
bash ${DIR}/build_scripts/android-fix-toolchain.sh
bash ${DIR}/build_scripts/android_compile_v8.sh ${ANDROID_NDK}
bash ${DIR}/cordova_android/build.sh ${ANDROID_NDK} ${DIR}/out_android/android/bin

rm -rf ${DIR}/out_libjxcore
mkdir ${DIR}/out_libjxcore
cp -r ${DIR}/cordova_android/libs/* ${DIR}/out_libjxcore
rm -rf ${DIR}/cordova_android/libs/

LOG $GREEN_COLOR "libjxcore.so are ready under ${DIR}/out_libjxcore\n"

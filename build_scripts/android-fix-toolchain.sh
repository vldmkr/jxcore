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

FIX=${PWD}/toolchain_fix

ARM7=${PWD}/android-toolchain-arm
INTEL32=${PWD}/android-toolchain-intel

if [ -d "${ARM7}" ]; then
  cp -r ${FIX}/* ${ARM7}/
  LOG $GREEN_COLOR "${ARM7} fixed\n"
else
  LOG $RED_COLOR "${ARM7} does not exist\n"
fi

if [ -d "${INTEL32}" ]; then
  cp -r ${FIX}/* ${INTEL32}/
  LOG $GREEN_COLOR "${INTEL32} fixed\n"
else
  LOG $RED_COLOR "${INTEL32} does not exist\n"
fi

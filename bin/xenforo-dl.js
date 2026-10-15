#!/usr/bin/env node

import XenForoDownloaderCLI from '../dist/cli/index.js';

try {
  await (new XenForoDownloaderCLI()).start();
}
catch (error) {
  console.error(error instanceof Error ? error.message : 'Downloader failed');
  process.exitCode = 1;
}

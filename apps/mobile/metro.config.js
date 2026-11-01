// The app imports plain-TypeScript packages from the repo (timeline, design tokens, risk words,
// protocol types) by relative path; Metro must watch those folders to bundle them.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const repo = path.resolve(__dirname, '../..');
config.watchFolders = ['packages/timeline', 'packages/design-tokens', 'packages/protocol', 'packages/core'].map((p) => path.join(repo, p));
module.exports = config;

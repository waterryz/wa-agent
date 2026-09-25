// Local installs also default to using an already installed Chromium.
// Production additionally uses npm ci --ignore-scripts and an explicit path.
module.exports = { skipDownload: true };

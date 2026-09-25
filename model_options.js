// Keep the existing model. Only disable thinking on models documented to support it.
function shortAnswerOptions(model) {
  return /^kimi-k2\.[56](?:$|-)/i.test(model || '')
    ? { thinking: { type: 'disabled' } }
    : {};
}
module.exports = { shortAnswerOptions };

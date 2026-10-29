const test = require('node:test');
const assert = require('node:assert/strict');
const {latestSourceItems, findVideoItems, itemFromPageRenderer} = require('./update-youtube');

test('each source keeps the newest 40 distinct videos', () => {
  const rows = Array.from({length: 75}, (_, i) => ({videoId: String(i), publishedAt: new Date(2026, 0, i + 1).toISOString()}));
  const result = latestSourceItems([...rows, rows[74]]);
  assert.equal(result.length, 40);
  assert.equal(result[0].videoId, '74');
  assert.equal(result.at(-1).videoId, '35');
  assert.equal(latestSourceItems(rows.slice(0, 8)).length, 8);
});

test('modern Shorts cards retain title, video identity and Shorts classification', () => {
  const data = {contents: [{shortsLockupViewModel: {onTap: {innertubeCommand: {reelWatchEndpoint: {videoId: 'abc123'}}}, overlayMetadata: {primaryText: {content: 'Shorts title'}}}}]};
  const result = findVideoItems(data).map(item => itemFromPageRenderer(item));
  assert.equal(result.length, 1);
  assert.equal(result[0].videoId, 'abc123');
  assert.equal(result[0].title, 'Shorts title');
  assert.equal(result[0].isShort, true);
});

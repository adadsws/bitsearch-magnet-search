import test from 'node:test';
import assert from 'node:assert/strict';
import paths from '../static/file_paths.js';

const {mergeFileSizes,summarizeFileTree,sortedFileEntries} = paths;

test('Torrent 根目录与 API 相对路径对应后只显示一次', () => {
  const api = [{path:'1.mp4',size:null},{path:'1.jpg',size:null}];
  const metadata = [{path:'ABP-211/1.mp4',size:1875117973},{path:'ABP-211/1.jpg',size:181885}];
  const result = mergeFileSizes(api, metadata);
  assert.deepEqual(result.files.map(file=>file.path),['1.mp4','1.jpg']);
  assert.deepEqual(result.files.map(file=>file.size),[1875117973,181885]);
  assert.equal(result.matched,2);
  assert.equal(result.unmatchedApi,0);
});

test('反斜杠、大小写及 Unicode 等价路径可以对应', () => {
  const result = mergeFileSizes([{path:'Root\\ＡＢＰ-211.MP4'}], [{path:'root/ABP-211.mp4',size:42}]);
  assert.equal(result.files[0].path,'Root\\ＡＢＰ-211.MP4');
  assert.equal(result.files[0].size,42);
  assert.equal(result.matched,1);
});

test('重名文件不猜测 API 路径，完整 Torrent 文件表去重且保留大小', () => {
  const result = mergeFileSizes([{path:'clip.mp4'},{path:'API 额外路径'}], [
    {path:'Root/A/clip.mp4',size:10},
    {path:'Root/B/clip.mp4',size:20},
  ]);
  assert.deepEqual(result.files.map(file=>file.path),['Root/A/clip.mp4','Root/B/clip.mp4']);
  assert.deepEqual(result.files.map(file=>file.size),[10,20]);
  assert.equal(result.unmatchedApi,2);
});

test('文件夹统计后代文件数量，未知大小向上层传递', () => {
  const known={folders:new Map(),files:new Map([['a.mkv',100],['b.mkv',200]])};
  const unknown={folders:new Map(),files:new Map([['c.mkv',null]])};
  const root={folders:new Map([['known',known],['unknown',unknown]]),files:new Map()};
  assert.deepEqual(summarizeFileTree(root),{count:3,bytes:null});
  assert.deepEqual(known.total,{count:2,bytes:300});
  assert.deepEqual(unknown.total,{count:1,bytes:null});
});

test('同级列表按大小和数量双向排序，未知大小固定置后', () => {
  const folder={folders:new Map(),files:new Map([['a',30],['b',20]])};
  const root={folders:new Map([['目录',folder]]),files:new Map([['大文件',100],['无大小',null],['小文件',10]])};
  summarizeFileTree(root);
  assert.deepEqual(sortedFileEntries(root,'size','desc').map(item=>item.name),['大文件','目录','小文件','无大小']);
  assert.deepEqual(sortedFileEntries(root,'size','asc').map(item=>item.name),['小文件','目录','大文件','无大小']);
  assert.equal(sortedFileEntries(root,'count','desc')[0].name,'目录');
});

test('名称升降序都先列文件夹，组内分别排序', () => {
  const folder={folders:new Map(),files:new Map([['inner',1]])};
  const root={folders:new Map([['A目录',folder],['Z目录',folder]]),files:new Map([['B文件',1],['Y文件',2]])};
  summarizeFileTree(root);
  assert.deepEqual(sortedFileEntries(root,'name','asc').map(item=>item.name),['A目录','Z目录','B文件','Y文件']);
  assert.deepEqual(sortedFileEntries(root,'name','desc').map(item=>item.name),['Z目录','A目录','Y文件','B文件']);
});

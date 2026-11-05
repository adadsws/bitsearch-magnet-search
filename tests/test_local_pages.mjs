// 本地页跨 API 页装配的顺序、游标与停止条件。
import test from 'node:test';
import assert from 'node:assert/strict';
import paging from '../static/local_pages.js';

const {assembleLocalPage,rowDate,torrentIdentity,uniqueTorrents}=paging;

test('列表创建日期优先于更新时间，详情创建日期优先于列表日期',()=>{
  const row={createdAt:'2026-11-05T10:00:00Z',updatedAt:'2026-11-04T10:00:00Z'};
  assert.equal(rowDate(row,null),'2026-11-05');
  assert.equal(rowDate(row,{createdAt:'2026-11-03T10:00:00Z'}),'2026-11-03');
});

test('相同 infohash 去重；无效 hash 回退到 ID',()=>{
  const hash='a'.repeat(40),rows=[{id:1,infohash:hash},{id:2,infohash:hash.toUpperCase()},{id:3,infohash:'bad'},{id:4,infohash:'bad'}];
  assert.equal(torrentIdentity(rows[0]),torrentIdentity(rows[1]));
  assert.deepEqual(uniqueTorrents(rows).map(row=>row.id),[1,3,4]);
});

function fixture(pages,accepted){
  const calls=[],details=[];
  return {
    calls,details,
    getPage:async number=>{calls.push(number);return {results:pages[number-1],pagination:{hasNext:number<pages.length,totalPages:pages.length,total:pages.flat().length,perPage:pages[0].length}};},
    getDetail:async row=>{details.push(row.id);return {id:row.id};},
    matches:row=>accepted.has(row.id),
  };
}

test('一个本地页跨 API 页，下一本地页从页内游标续扫',async()=>{
  const pages=[[1,2,3],[4,5,6]].map(page=>page.map(id=>({id})));
  const source=fixture(pages,new Set([2,3,4,5,6]));
  const first=await assembleLocalPage({start:{page:1,index:0},target:3,...source});
  assert.deepEqual(first.rows.map(row=>row.id),[2,3,4]);
  assert.deepEqual([first.startApiPage,first.endApiPage],[1,2]);
  assert.deepEqual(first.cursor,{page:2,index:1});
  const second=await assembleLocalPage({start:first.cursor,target:3,...source});
  assert.deepEqual(second.rows.map(row=>row.id),[5,6]);
  assert.equal(second.exhausted,true);
  assert.deepEqual([second.startApiPage,second.endApiPage],[2,2]);
});

test('不足目标条数时只在 API 结果耗尽后返回末页',async()=>{
  const source=fixture([[{id:1}],[{id:2}],[{id:3}]],new Set([3]));
  const page=await assembleLocalPage({start:{page:1,index:0},target:2,...source});
  assert.deepEqual(page.rows.map(row=>row.id),[3]);
  assert.deepEqual(source.calls,[1,2,3]);
  assert.equal(page.exhausted,true);
});

test('明显不符合总大小的结果不请求详情',async()=>{
  const source=fixture([[{id:1,size:1},{id:2,size:5},{id:3,size:7}]],new Set([1,2,3]));
  const page=await assembleLocalPage({start:{page:1,index:0},target:2,canMatch:row=>row.size>=5,...source});
  assert.deepEqual(page.rows.map(row=>row.id),[2,3]);
  assert.deepEqual(source.details,[2,3]);
});

test('详情错误中断装配，不把未知条目当成不匹配',async()=>{
  const source=fixture([[{id:1},{id:2}]],new Set([1,2]));
  source.getDetail=async row=>{if(row.id===1)throw Error('详情失败');return row;};
  await assert.rejects(assembleLocalPage({start:{page:1,index:0},target:2,...source}),/详情失败/);
});

test('相邻 API 页重复的条目只进入一个本地页',async()=>{
  const source=fixture([[{id:1},{id:2}],[{id:2},{id:3}]],new Set([1,2,3]));
  const first=await assembleLocalPage({start:{page:1,index:0},target:2,...source});
  const second=await assembleLocalPage({start:first.cursor,target:2,seenIds:new Set(first.rows.map(row=>row.id)),...source});
  assert.deepEqual(first.rows.map(row=>row.id),[1,2]);
  assert.deepEqual(second.rows.map(row=>row.id),[3]);
  assert.equal(second.exhausted,true);
});

test('不同 API ID 但同 infohash 不重复占用本地页目标',async()=>{
  const hash='b'.repeat(40),source=fixture([[{id:1,infohash:hash},{id:2,infohash:hash},{id:3,infohash:'c'.repeat(40)}]],new Set([1,2,3]));
  const page=await assembleLocalPage({start:{page:1,index:0},target:2,identity:torrentIdentity,...source});
  assert.deepEqual(page.rows.map(row=>row.id),[1,3]);
});

test('列表候选不取详情，手动核实后继续扫描直至目标命中',async()=>{
  const pages=[[1,2,3],[4,5,6]].map(page=>page.map(id=>({id})));
  const source=fixture(pages,new Set([2,4]));
  const preview=await assembleLocalPage({start:{page:1,index:0},target:2,getPage:source.getPage,getDetail:async()=>null,matches:()=>true});
  assert.deepEqual(preview.rows.map(row=>row.id),[1,2]);
  assert.deepEqual(source.details,[]);
  const verified=await assembleLocalPage({start:{page:1,index:0},target:2,...source});
  assert.deepEqual(verified.rows.map(row=>row.id),[2,4]);
  assert.deepEqual([verified.startApiPage,verified.endApiPage],[1,2]);
});

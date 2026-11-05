// 按 API 原始顺序装配一个本地页；游标记录 API 页及页内下一条，供后续本地页续扫。
function rowDate(row,detail){return (detail?.createdAt||row.createdAt||detail?.updatedAt||row.updatedAt||"").slice(0,10);}
function torrentIdentity(row){const hash=String(row.infohash||"").trim().toUpperCase();return /^[0-9A-F]{40}$/.test(hash)?`hash:${hash}`:`id:${row.id}`;}
function uniqueTorrents(list){const seen=new Set();return list.filter(row=>{const key=torrentIdentity(row);if(seen.has(key))return false;seen.add(key);return true;});}
async function assembleLocalPage({start,target,getPage,getDetail,matches,canMatch=()=>true,seenIds=new Set(),identity=row=>row.id,isCurrent=()=>true,onProgress=()=>{}}){
  let apiPage=start.page,index=start.index,lastApiPage=apiPage;
  const selected=[],seen=new Set(seenIds);
  while(selected.length<target){
    if(!isCurrent())return null;
    const data=await getPage(apiPage);
    if(!isCurrent())return null;
    const apiRows=data.results||[],paging=data.pagination||{};
    const hasMore=Boolean(paging.hasNext??(apiPage<Number(paging.totalPages||0)));
    onProgress(apiPage,selected.length,target);
    while(index<apiRows.length&&selected.length<target){
      const candidates=[];
      while(index<apiRows.length&&candidates.length<4){
        const rowIndex=index++,row=apiRows[rowIndex];
        if(!seen.has(identity(row))&&canMatch(row))candidates.push({row,index:rowIndex});
      }
      const resolved=await Promise.all(candidates.map(async item=>({...item,detail:await getDetail(item.row)})));
      if(!isCurrent())return null;
      for(const item of resolved){
        const key=identity(item.row);
        if(!seen.has(key)&&matches(item.row,item.detail)){selected.push(item.row);seen.add(key);}
        if(selected.length===target){index=item.index+1;break;}
      }
      onProgress(apiPage,selected.length,target);
    }
    lastApiPage=apiPage;
    if(selected.length===target||!hasMore){
      const exhausted=!hasMore&&index>=apiRows.length;
      const cursor=index>=apiRows.length&&hasMore?{page:apiPage+1,index:0}:{page:apiPage,index};
      return {rows:selected,startApiPage:start.page,endApiPage:lastApiPage,cursor,exhausted,paging};
    }
    apiPage++;index=0;
  }
  throw Error("本地页目标条数无效");
}

if(typeof module!=="undefined")module.exports={assembleLocalPage,rowDate,torrentIdentity,uniqueTorrents};

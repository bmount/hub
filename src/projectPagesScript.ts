export const PROJECT_PAGES_JS = String.raw`
(function(){
 if(window.__pwPages)return;window.__pwPages=1;
 document.addEventListener('click',async function(e){
  if(e.target.closest('#copy-page')){try{await navigator.clipboard.writeText(location.href);e.target.textContent='Copied'}catch{prompt('Copy link',location.href)}}
  if(e.target.closest('#full-page')){var el=document.getElementById('page-view');try{await el.requestFullscreen()}catch{document.querySelector('.page-bar').style.display='none';document.querySelector('.page-history')?.remove()}}
 });
 document.addEventListener('dragover',function(e){if(e.target.closest('#page-drop'))e.preventDefault()});
 document.addEventListener('drop',function(e){if(!e.target.closest('#page-drop'))return;e.preventDefault();if(e.dataTransfer.files.length===1){document.querySelector('#page-upload input[type=file]').files=e.dataTransfer.files}else alert('Drop one file')});
})();
`;

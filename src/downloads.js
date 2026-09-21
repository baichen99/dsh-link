// Native export uses a detached anchor; both that path and visible links must
// fetch through the carrier before handing a blob to the download manager.
export function installDownloads({ HTMLAnchorElement, document, location, fetch, URL, setTimeout }) {
const anchorClick = HTMLAnchorElement.prototype.click;
function download(anchor) {
  const href = anchor.getAttribute('href');
  if (!href) return false;
  const url = new URL(href, location.href);
  if (!url.pathname.startsWith('/api/') || !['http:', 'https:'].includes(url.protocol)) return false;
  void fetch(url.pathname + url.search).then(async response => {
    if (!response.ok) throw new Error('Download failed');
    const objectUrl = URL.createObjectURL(await response.blob());
    const save = document.createElement('a');
    save.href = objectUrl; save.download = anchor.download || 'download';
    anchorClick.call(save);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }).catch(() => {
    const notice = document.createElement('p');
    notice.setAttribute('role', 'alert');
    notice.textContent = '文件下载失败，请检查连接后重试。';
    document.body.prepend(notice);
  });
  return true;
}
HTMLAnchorElement.prototype.click = function () { if (!download(this)) anchorClick.call(this); };
document.addEventListener('click', event => {
  const anchor = event.target?.closest('a');
  if (anchor && download(anchor)) event.preventDefault();
}, true);

}

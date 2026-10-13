// Progressive enhancement: the server-rendered SVG and connection list work without JS.
export const CONTACT_GRAPH_SCRIPT = String.raw`(() => {
  if (window.pimwellContactGraph) return;
  window.pimwellContactGraph = true;
  function setup(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = '1';
    const svg = root.querySelector('svg');
    let drag = null, moved = false;
    root.querySelectorAll('[data-graph-zoom]').forEach(button => button.addEventListener('click', () => {
      const v = svg.viewBox.baseVal, scale = Number(button.dataset.graphZoom);
      const width = Math.max(100, Math.min(3600, v.width * scale)), height = width * 2 / 3;
      svg.setAttribute('viewBox', [v.x + (v.width-width)/2, v.y + (v.height-height)/2, width, height].join(' '));
    }));
    svg.addEventListener('pointerdown', event => {
      const node = event.target.closest('[data-node]');
      if (!node) return;
      drag = {node, id: event.pointerId, x: event.clientX, y: event.clientY}; moved = false;
    });
    svg.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (Math.hypot(event.clientX-drag.x, event.clientY-drag.y) < 4 && !moved) return;
      if (!moved) svg.setPointerCapture(event.pointerId);
      moved = true;
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
      drag.node.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');
      svg.querySelectorAll('line').forEach(line => {
        if (line.dataset.a === drag.node.dataset.node) {line.setAttribute('x1', p.x); line.setAttribute('y1', p.y);}
        if (line.dataset.b === drag.node.dataset.node) {line.setAttribute('x2', p.x); line.setAttribute('y2', p.y);}
      });
    });
    svg.addEventListener('pointerup', event => {if (drag && event.pointerId === drag.id) {svg.releasePointerCapture(event.pointerId); drag = null;}});
    svg.addEventListener('pointercancel', () => {drag = null;});
    svg.addEventListener('click', event => {if (moved) {event.preventDefault(); moved = false;}}, true);
  }
  function init() {document.querySelectorAll('[data-contact-graph]').forEach(setup);}
  init();
  new MutationObserver(init).observe(document.body, {childList:true, subtree:true});
})();`;

// Rendered contrast and keyboard focus audit, reused by the screenshot harness.
import { expect } from '@playwright/test';
export async function auditControls(page, name) {
  await page.evaluate(() => {
    const probe=document.createElement('div');probe.id='design-control-audit';
    probe.style.cssText='position:fixed;top:100px;left:8px;z-index:9999;background:var(--panel);padding:8px';
    probe.innerHTML='<button class="primary">Primary</button> <button class="quiet">Secondary</button> <button class="link">Tertiary</button>';
    document.body.append(probe);
  });
  try {
    for (const control of await page.locator('#design-control-audit button').all()) {
      await control.hover();
      await page.mouse.down();
      expect(await control.evaluate(el=>getComputedStyle(el).boxShadow),name+' pressed control').toContain('inset');
      await page.mouse.up();
      await control.evaluate(el=>{el.disabled=true;});
      expect(await control.evaluate(el=>getComputedStyle(el).boxShadow),name+' disabled control while hovered').toBe('none');
    }
  } finally {
    await page.evaluate(()=>document.getElementById('design-control-audit').remove());
  }
  for (const primary of await page.locator('.bar .file,.wb-toolbar button.primary,.wb-comment button[type=submit],.channel-compose button[type=submit],.landing-create>summary').all()) {
    if (!await primary.isVisible() || !await primary.isEnabled()) continue;
    expect(await primary.evaluate(el=>getComputedStyle(el).backgroundImage),name+' visible gradient primary').toContain('linear-gradient');
    expect(await primary.evaluate(el=>getComputedStyle(el).color),name+' white primary text').toBe('rgb(255, 255, 255)');
  }
  for (const chip of await page.locator('.wb-readiness .wb-state').all()) {
    expect(await chip.evaluate(el=>getComputedStyle(el).boxShadow),name+' unboxed readiness').toBe('none');
    expect(await chip.evaluate(el=>getComputedStyle(el).backgroundColor),name+' transparent readiness').toBe('rgba(0, 0, 0, 0)');
  }
  for (const selected of await page.locator('.wb-tree a[aria-current]').all()) {
    expect(await selected.evaluate(el=>getComputedStyle(el).borderRadius),name+' square accent bar, not a curved glyph').toBe('0px');
  }
  await page.keyboard.press('Tab'); // establish keyboard focus modality
  const failures = await page.evaluate(() => {
    const failures = [];
    // CSS Color 4 (including color-mix) serializes as color(srgb …), not rgb().
    const canvas = document.createElement('canvas'); canvas.width=canvas.height=1;
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const rgb = value => {
      ctx.clearRect(0,0,1,1); ctx.fillStyle=value; ctx.fillRect(0,0,1,1);
      const [r,g,b,a]=ctx.getImageData(0,0,1,1).data;
      return [r,g,b,a/255];
    };
    const luminance = c => c.slice(0,3).map(v => {v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;}).reduce((n,v,i) => n + v * [.2126,.7152,.0722][i],0);
    const contrast = (a,b) => {const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    function backgrounds(el) {
      for (; el; el=el.parentElement) {
        const s=getComputedStyle(el);
        const gradient=s.backgroundImage.match(/rgba?\([^)]+\)/g);
        if (gradient) return gradient.map(rgb);
        const c=rgb(s.backgroundColor);
        if(c.length===3 || c[3]===1) return [c];
      }
      return [[255,255,255]];
    }
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const node=walker.currentNode, el=node.parentElement;
      if(!node.textContent.trim() || !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) || el.closest('script,style')) continue;
      const range=document.createRange();range.selectNodeContents(node);
      if(![...range.getClientRects()].some(r=>r.width && r.height)) continue;
      const style=getComputedStyle(el), fg=rgb(style.color);
      const min = parseFloat(style.fontSize)>=24 || (parseFloat(style.fontSize)>=18.66 && Number(style.fontWeight)>=700) ? 3 : 4.5;
      const ratio=Math.min(...backgrounds(el).map(bg=>contrast(fg,bg)));
      if(ratio < min) failures.push(`contrast ${ratio.toFixed(2)}: ${el.tagName}.${el.className} ${node.textContent.trim().slice(0,45)}`);
    }
    for(const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]')) {
      if(el.disabled || el.tabIndex<0 || !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
      el.focus({preventScroll:true});
      if(document.activeElement !== el) continue; // e.g. summary of an already-hidden editor
      const s=getComputedStyle(el);
      if(s.outlineStyle==='none' || parseFloat(s.outlineWidth)<2) failures.push(`focus: ${el.tagName}.${el.className}`);
      else if(Math.min(...backgrounds(el.parentElement).map(bg=>contrast(rgb(s.outlineColor),bg)))<3) failures.push(`focus contrast: ${el.tagName}.${el.className}`);
    }
    if(document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return [...new Set(failures)];
  });
  expect(failures, name+' AA text and visible keyboard focus').toEqual([]);
  // The jump search closes on a debounced blur; don't use Escape, which also closes inspectors.
  await expect(page.locator('.jump ul')).toHaveCount(0);
}
export async function rowGeometry(page) {
  return page.locator('table tr').evaluateAll(rows=>rows.map(r=>Math.round(r.getBoundingClientRect().height*100)/100));
}

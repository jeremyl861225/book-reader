/* 插圖放大檢視：先整張看見，再捏合／點擊放大到看得清標籤。
 *
 * 手術圖譜這類書一頁會排六到十六張分圖，整版縮進手機寬度後標籤只剩幾個像素。
 * 原本的做法是把圖以原始寬度塞進可捲動的容器，等於固定放大倍率——
 * 對寬表格夠用，對這種圖不夠：使用者需要能一路放大到單張分圖填滿螢幕。
 *
 * 所以改成自己算 transform：
 * - 開啟時縮到整張看得見（fit），先知道自己在看什麼
 * - 捏合縮放、拖曳平移，滑鼠滾輪也可以
 * - 點圖片一下＝在 fit 和 3 倍之間切換，切換中心就是點下去的位置
 * - 點圖片以外的地方或 ✕ 關閉（拖曳不算點擊）
 */

const MAX_SCALE = 12;       // 相對於「整張看得見」的倍率上限
const TAP_SLOP = 8;         // 位移小於這個距離才算點擊，不算拖曳

export function openZoom(src, alt) {
  const ov = document.createElement('div');
  ov.className = 'zoom-overlay';

  const img = document.createElement('img');
  img.src = src;            // 圖說可能帶引號，一律走 DOM 設值不要拼 HTML
  img.alt = alt;
  img.draggable = false;

  const close = document.createElement('button');
  close.className = 'zoom-close';
  close.setAttribute('aria-label', '關閉');
  close.textContent = '✕';

  ov.append(img, close);
  document.body.appendChild(ov);

  const view = new PanZoom(ov, img);
  const dismiss = () => { view.destroy(); ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', dismiss);
  ov.addEventListener('zoom-dismiss', dismiss);
}

class PanZoom {
  constructor(box, img) {
    this.box = box;
    this.img = img;
    this.pointers = new Map();
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.fit = 1;
    this.moved = 0;

    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onWheel = this.onWheel.bind(this);

    box.addEventListener('pointerdown', this.onDown);
    box.addEventListener('pointermove', this.onMove);
    box.addEventListener('pointerup', this.onUp);
    box.addEventListener('pointercancel', this.onUp);
    box.addEventListener('wheel', this.onWheel, { passive: false });

    if (img.complete && img.naturalWidth) this.reset();
    else img.addEventListener('load', () => this.reset(), { once: true });
  }

  destroy() {
    this.box.removeEventListener('pointerdown', this.onDown);
    this.box.removeEventListener('pointermove', this.onMove);
    this.box.removeEventListener('pointerup', this.onUp);
    this.box.removeEventListener('pointercancel', this.onUp);
    this.box.removeEventListener('wheel', this.onWheel);
  }

  reset() {
    const r = this.box.getBoundingClientRect();
    const w = this.img.naturalWidth || 1;
    const h = this.img.naturalHeight || 1;
    this.fit = Math.min(r.width / w, r.height / h);
    this.scale = this.fit;
    this.x = (r.width - w * this.scale) / 2;
    this.y = (r.height - h * this.scale) / 2;
    this.apply();
  }

  apply() {
    this.img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
  }

  clamp() {
    const r = this.box.getBoundingClientRect();
    const w = this.img.naturalWidth * this.scale;
    const h = this.img.naturalHeight * this.scale;
    // 比視窗小就置中，比視窗大就不准拖到邊界內側，免得整張圖被拖出畫面
    this.x = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, this.x));
    this.y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, this.y));
  }

  zoomTo(scale, cx, cy) {
    const next = Math.max(this.fit, Math.min(this.fit * MAX_SCALE, scale));
    const k = next / this.scale;
    this.x = cx - (cx - this.x) * k;      // 以 (cx, cy) 為定點縮放
    this.y = cy - (cy - this.y) * k;
    this.scale = next;
    this.clamp();
    this.apply();
  }

  onDown(e) {
    this.box.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.moved = 0;
      this.downOnImg = e.target === this.img;
    }
    this.pinch = null;
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...this.pointers.values()];

    if (pts.length >= 2) {
      const now = pinchOf(pts);
      if (this.pinch) {
        const r = this.box.getBoundingClientRect();
        this.x += now.cx - this.pinch.cx;
        this.y += now.cy - this.pinch.cy;
        this.zoomTo(this.scale * (now.dist / this.pinch.dist),
                    now.cx - r.left, now.cy - r.top);
      }
      this.pinch = now;
      this.moved = TAP_SLOP + 1;
      e.preventDefault();
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.x += dx;
    this.y += dy;
    this.clamp();
    this.apply();
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size) return;
    if (this.moved > TAP_SLOP) return;

    if (!this.downOnImg) {
      this.box.dispatchEvent(new CustomEvent('zoom-dismiss'));
      return;
    }
    const r = this.box.getBoundingClientRect();
    const zoomed = this.scale > this.fit * 1.05;
    this.zoomTo(zoomed ? this.fit : this.fit * 3, e.clientX - r.left, e.clientY - r.top);
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.box.getBoundingClientRect();
    this.zoomTo(this.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15),
                e.clientX - r.left, e.clientY - r.top);
  }
}

function pinchOf(pts) {
  const [a, b] = pts;
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
  };
}

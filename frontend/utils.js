// Small utilities — JSON highlight, time formatting, uuid, etc.

window.uuid = () => {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

window.highlightJson = (obj) => {
  if (obj === undefined) return "";
  let str = JSON.stringify(obj, null, 2);
  // escape
  str = str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  str = str.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:?)|(\b(true|false|null)\b)|(-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, (m) => {
    let cls = "n";
    if (/^"/.test(m)) {
      cls = /:$/.test(m) ? "k" : "s";
    } else if (/true|false/.test(m)) {
      cls = "b";
    } else if (/null/.test(m)) {
      cls = "null";
    }
    return `<span class="${cls}">${m}</span>`;
  });
  return str;
};

window.fmtDate = (iso) => {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${d.getFullYear()}.${mm}.${dd} ${hh}:${mi}`;
  } catch { return iso; }
};

window.fmtKRW = (n) => {
  if (n === 0) return "무료";
  return "₩" + new Intl.NumberFormat("ko-KR").format(n);
};

window.fmtShort = (s, n = 12) => {
  if (!s) return "—";
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
};

// Pseudo QR pattern from a string
window.qrPattern = (seed = "") => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const cells = [];
  for (let i = 0; i < 49; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    cells.push((h & 1) === 1);
  }
  // corners: finder patterns (top-left, top-right, bottom-left)
  const tl = [0,1,2,3,4,5,6, 7,13, 14,18,19,20, 21,25,27, 28,32,34, 35,39,41, 42,43,44,45,46,47,48];
  return cells;
};

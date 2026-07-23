const $ = (id) => document.getElementById(id);

export function setPill(id, cls, text) {
  const p = $(id);
  p.className = 'pill ' + cls;
  p.innerHTML = '<i></i>' + text;
}

let toastT;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

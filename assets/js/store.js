// The app keeps its data as small JSON files inside the app (through the Android bridge):
//   plans.json        list of planograms
//   plan-<id>.json    one read planogram
//   user.json         recent articles, barcodes linked by hand, last changes
const A = window.Android;

export function read(name, fallback) {
  try {
    const s = A.readText(name);
    return s ? JSON.parse(s) : fallback;
  } catch (e) {
    console.warn('read ' + name, e);
    return fallback;
  }
}

export function write(name, value) {
  try {
    return A.writeText(name, JSON.stringify(value)) !== false;
  } catch (e) {
    console.warn('write ' + name, e);
    return false;
  }
}

export function remove(name) {
  try {
    A.deleteText(name);
  } catch (e) {
    console.warn('delete ' + name, e);
  }
}

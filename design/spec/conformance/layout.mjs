// 版面数值验收：只用角色、名称和文字定位两个锚点，按“各自所在的块”量间距，不依赖实现的结构与类名。
// 一个锚点的块＝它最外层、但不包含另一个锚点的祖先；gap(a, b) 是 b 的块顶边到 a 的块底边的距离。
const handles = (a, b) => Promise.all([a.first().elementHandle(), b.first().elementHandle()]);

export async function gap(a, b) {
  const [x, y] = await handles(a, b);
  return x.evaluate((node, other) => {
    const outer = (n, o) => {
      let block = n;
      while (block.parentElement && !block.parentElement.contains(o)) block = block.parentElement;
      return block;
    };
    return (
      outer(other, node).getBoundingClientRect().top -
      outer(node, other).getBoundingClientRect().bottom
    );
  }, y);
}

export async function besideGap(a, b) {
  const [x, y] = await handles(a, b);
  return x.evaluate((node, other) => {
    const outer = (n, o) => {
      let block = n;
      while (block.parentElement && !block.parentElement.contains(o)) block = block.parentElement;
      return block;
    };
    return (
      outer(other, node).getBoundingClientRect().left -
      outer(node, other).getBoundingClientRect().right
    );
  }, y);
}

export const height = async (locator) => (await locator.first().boundingBox()).height;

// 从文字往外找第一个不透明的底色，返回 sRGB 三元组（浏览器把 lab 混色换算成 rgb 读出）。
export async function fill(locator) {
  return locator.first().evaluate((node) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    for (
      let element = node;
      element;
      element = element.parentElement ?? element.getRootNode().host
    ) {
      const color = getComputedStyle(element).backgroundColor;
      if (color && !/rgba\(0, 0, 0, 0\)|transparent/.test(color)) {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      }
    }
    return null;
  });
}

export function near(name, actual, expected, tolerance = 1) {
  const list = Array.isArray(expected) ? expected : [expected];
  const values = Array.isArray(actual) ? actual : [actual];
  if (
    values.length !== list.length ||
    values.some((value, i) => Math.abs(value - list[i]) > tolerance)
  )
    throw new Error(
      `${name}: expected ${JSON.stringify(expected)} ±${tolerance}, got ${JSON.stringify(actual)}`,
    );
}

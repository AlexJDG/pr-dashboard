type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const fill = (element: Element, attrs: Attrs, children: (Child | Child[])[]) => {
    Object.entries(attrs).forEach(([name, value]) => {
        if (value === undefined || value === false) {
            return;
        }
        element.setAttribute(name, value === true ? "" : String(value));
    });
    element.append(...children.flat().flatMap((child) => (child === null || child === undefined || child === false ? [] : [child])));
    return element;
};

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]) =>
    fill(document.createElement(tag), attrs, children) as HTMLElementTagNameMap[K];

export const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]) =>
    fill(document.createElementNS(SVG_NAMESPACE, tag), attrs, children) as SVGElementTagNameMap[K];

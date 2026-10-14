const GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ0123456789ABCDEF<>/{}=+*";

export const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "0";

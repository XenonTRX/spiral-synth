// Reading the stylesheet's colours from code that draws on a canvas.
//
// A canvas gets no styling. Everything drawn into one is a literal colour, which means every colour
// in a chart is a second place the theme is defined, and the two drift the moment anyone adjusts
// the palette - the app changes and the pictures inside it do not.
//
// So the canvas asks the stylesheet. The custom properties on :root are the single definition, and
// a fallback is passed alongside for the case where the property has not been declared, which keeps
// a mistyped variable name from painting something in transparent black.

export function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

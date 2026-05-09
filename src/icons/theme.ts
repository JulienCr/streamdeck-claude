// Layout constants (canvas is 144x144). The Stream Deck button has rounded
// corners (radius ~20px on hardware), so we keep all content inside a safe
// inset and use a matching corner radius for our own border.
export const BORDER_INSET = 5;     // outer rect x/y offset
export const BORDER_SIZE = 144 - 2 * BORDER_INSET;
export const BORDER_RADIUS = 20;
export const BORDER_STROKE = 5;    // user requested +2 over previous 3px
export const VIEWPORT_X = 10;
export const VIEWPORT_W = 144 - 2 * VIEWPORT_X;
export const TOP_BASELINE = 30;
export const TOP_FONT = 19;
export const BOTTOM_LINE1_Y = 100;
export const BOTTOM_LINE2_Y = 122;
export const BOTTOM_FONT = 17;

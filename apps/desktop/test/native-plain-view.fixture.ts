/** Native paint layer only; it owns no WebContents or browser-page identity. */
export class FakePlainView {
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  background = '';
  blur = 0;
  setVisible(value: boolean) {
    this.visible = value;
  }
  getVisible() {
    return this.visible;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = { ...value };
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBackgroundColor(value: string) {
    this.background = value;
  }
  setBackgroundBlur(value: number) {
    this.blur = value;
  }
}

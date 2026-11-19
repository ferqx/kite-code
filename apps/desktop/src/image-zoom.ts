export const imageZoomChoices = [
  'fit',
  'out',
  'in',
  '0.5',
  '0.75',
  '1',
  '1.25',
  '1.5',
  '2',
] as const;
export type ImageZoomChoice = (typeof imageZoomChoices)[number];
export type ImageZoomControl = { kind: 'image-zoom'; value: ImageZoomChoice | 'state' };
export type ImageZoomState = { fit: boolean; scale: number; minimum: number };

export function validateImageZoom(control: ImageZoomControl) {
  if (
    Object.keys(control).sort().join(',') !== 'kind,value' ||
    !(control.value === 'state' || imageZoomChoices.includes(control.value))
  )
    throw Error('preview_control_invalid');
}

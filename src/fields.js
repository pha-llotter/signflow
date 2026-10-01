/**
 * The field catalogue. Shared by the placer palette, the signing form and the
 * stamper, so a type only has to be described once.
 *
 *  fill      - who supplies the value: 'signer', 'auto' (system), 'author' (fixed at prepare time)
 *  w/h       - default size as a fraction of the page
 *  render    - how the stamper draws it: text | image | check | qr | stamp | link | none
 */
export const FIELD_TYPES = {
  // Sized for the certification block that wraps the mark by default — a bare
  // signature needs far less room, but shrinking after the fact is easier than
  // discovering the details did not fit only once the document is sealed.
  signature:     { label: 'Signature',     fill: 'signer', w: 0.32, h: 0.090, render: 'image', group: 'Signing' },
  initials:      { label: 'Initials',      fill: 'signer', w: 0.08, h: 0.045, render: 'image', group: 'Signing' },
  date_signed:   { label: 'Date signed',   fill: 'auto',   w: 0.18, h: 0.030, render: 'text',  group: 'Signing' },
  stamp:         { label: 'Stamp',         fill: 'author', w: 0.22, h: 0.060, render: 'stamp', group: 'Signing' },

  textbox:       { label: 'Textbox',       fill: 'signer', w: 0.22, h: 0.030, render: 'text',  group: 'Details' },
  name:          { label: 'Name',          fill: 'auto',   w: 0.22, h: 0.030, render: 'text',  group: 'Details' },
  email:         { label: 'Email',         fill: 'auto',   w: 0.24, h: 0.030, render: 'text',  group: 'Details' },
  title:         { label: 'Job title',     fill: 'signer', w: 0.22, h: 0.030, render: 'text',  group: 'Details' },
  company:       { label: 'Company',       fill: 'signer', w: 0.24, h: 0.030, render: 'text',  group: 'Details' },
  editable_date: { label: 'Editable date', fill: 'signer', w: 0.16, h: 0.030, render: 'text',  group: 'Details' },

  checkbox:      { label: 'Checkbox',      fill: 'signer', w: 0.025, h: 0.018, render: 'check',  group: 'Choices' },
  dropdown:      { label: 'Dropdown',      fill: 'signer', w: 0.22, h: 0.030, render: 'text',   group: 'Choices' },
  radio:         { label: 'Radio group',   fill: 'signer', w: 0.22, h: 0.080, render: 'text',   group: 'Choices' },

  image:         { label: 'Image upload',  fill: 'signer', w: 0.22, h: 0.150, render: 'image',  group: 'Uploads' },
  drawing:       { label: 'Drawing',       fill: 'signer', w: 0.30, h: 0.150, render: 'image',  group: 'Uploads' },
  attachment:    { label: 'Attachment',    fill: 'signer', w: 0.22, h: 0.035, render: 'text',   group: 'Uploads' },

  label:         { label: 'Label',         fill: 'author', w: 0.22, h: 0.028, render: 'text',   group: 'Static' },
  hyperlink:     { label: 'Hyperlink',     fill: 'author', w: 0.22, h: 0.028, render: 'link',   group: 'Static' },
  qrcode:        { label: 'QR code',       fill: 'author', w: 0.10, h: 0.070, render: 'qr',     group: 'Static' },
};

export const STAMP_PRESETS = ['APPROVED', 'RECEIVED', 'REVIEWED', 'CONFIDENTIAL', 'DRAFT', 'PAID'];

export const FIELD_GROUPS = ['Signing', 'Details', 'Choices', 'Uploads', 'Static'];

export function isValidType(t) {
  return Object.hasOwn(FIELD_TYPES, t);
}

/** Types the signer is prompted to fill in on the signing page. */
export function isSignerFilled(t) {
  return FIELD_TYPES[t]?.fill === 'signer';
}

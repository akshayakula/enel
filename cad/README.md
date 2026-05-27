# CAD Notes

`arducam_zero_fpv_camera_mount.scad` is the editable parametric source for an Arducam Raspberry Pi Zero-style camera module on a 5-inch FPV drone frame.

`arducam_zero_fpv_camera_mount.stl` is the first-pass STL export for print/check-fit.

Current assumptions:

- Drone frame holes: M3 clearance holes, 32.5 mm center-to-center.
- Frame-connecting face: 25 mm maximum height.
- Camera module: skinny Arducam Pi Zero style, about 60 x 11.5 x 5.5 mm.
- Lens opening: 9 mm diameter.
- Flex/ribbon relief exits through the lower middle slot.

FPV frame references used:

- Traditional 5-inch frames commonly use M3 hardware, 30.5 x 30.5 mm and 20 x 20 mm stack patterns, and front camera mounts tied into standoffs.
- TBS Source One-style frames and similar freestyle frames often use printed front camera adapters or side-plate/standoff mounts rather than a full rectangular face.
- Many 5-inch builds use 20-30 mm standoffs, so the camera holder is kept inside the requested 25 mm height envelope.

The first model follows that style: two reinforced M3 standoff ears, a long low cradle for the skinny Arducam module, small front retaining lips, a central lens opening, and a flex-cable relief.

To revise the fit, edit the variables at the top of the `.scad` file. The most likely values to tune are `camera_body_width`, `camera_body_height`, `camera_body_depth`, `lens_opening_diameter`, and `lens_x_offset`.

If your Arducam is the 16MP/12MP 25 x 24 mm V2-style board instead of the skinny Pi Zero camera, this mount should be revised back to a square camera pocket.

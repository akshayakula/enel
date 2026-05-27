/*
  Arducam Pi Zero camera holder for a 5-inch FPV drone frame

  First-pass assumptions:
  - Drone frame mounting holes are M3, 32.5 mm center-to-center.
  - The frame-connecting face is no taller than 25 mm.
  - Camera is the skinny Arducam Raspberry Pi Zero style module,
    approximately 60 x 11.5 x 5.5 mm.

  Units: millimeters.
*/

$fn = 72;

frame_hole_spacing = 32.5;
frame_hole_diameter = 3.4;       // clearance for M3 bolts
frame_connector_height = 25;

camera_body_width = 60.0;
camera_body_height = 11.5;
camera_body_depth = 5.5;
camera_clearance = 0.7;

cradle_width = camera_body_width + 3.0;
cradle_height = camera_body_height + 2.0;
back_plate_thickness = 3.0;
front_lip_depth = 2.0;
front_lip_width = 3.0;

ear_diameter = 8.0;
ear_center_z = 4.8;

lens_opening_diameter = 9.0;
lens_x_offset = 0;               // tune if your Arducam lens is offset
lens_center_z = ear_center_z + 7.0;

cable_slot_width = 18.0;
cable_slot_height = 4.5;

module through_hole(x, z, diameter) {
  translate([x, 0, z])
    rotate([90, 0, 0])
      cylinder(h = back_plate_thickness + 1.0, d = diameter, center = true);
}

module front_cutout(width, height, depth, x, z) {
  translate([x, -back_plate_thickness / 2 - 0.01, z])
    cube([width, depth + 0.02, height], center = true);
}

module front_lip(x, z, w, h) {
  translate([x, -back_plate_thickness / 2 - front_lip_depth / 2, z])
    cube([w, front_lip_depth, h], center = true);
}

module fpv_zero_camera_profile() {
  hull() {
    // M3 standoff ears, matching common front hardware on 5-inch frames.
    for (x = [-frame_hole_spacing / 2, frame_hole_spacing / 2])
      translate([x, 0, ear_center_z])
        cylinder(h = back_plate_thickness, d = ear_diameter, center = true);

    // Long, low cradle for the Arducam Zero flex-board camera.
    translate([0, 0, lens_center_z])
      cube([cradle_width, back_plate_thickness, cradle_height], center = true);
  }
}

difference() {
  union() {
    fpv_zero_camera_profile();

    // Small lips retain the skinny camera module while leaving the lens,
    // ribbon/flex, and most of the front face open.
    front_lip(-cradle_width / 2 + front_lip_width / 2,
              lens_center_z, front_lip_width, cradle_height);
    front_lip(cradle_width / 2 - front_lip_width / 2,
              lens_center_z, front_lip_width, cradle_height);
    front_lip(-13.0, lens_center_z + cradle_height / 2 - 1.0,
              12.0, 2.0);
    front_lip(13.0, lens_center_z + cradle_height / 2 - 1.0,
              12.0, 2.0);
    front_lip(-13.0, lens_center_z - cradle_height / 2 + 1.0,
              12.0, 2.0);
    front_lip(13.0, lens_center_z - cradle_height / 2 + 1.0,
              12.0, 2.0);
  }

  // Camera module pocket.
  front_cutout(camera_body_width + camera_clearance,
               camera_body_height + camera_clearance,
               camera_body_depth + 0.6,
               0, lens_center_z);

  // Lens opening.
  translate([lens_x_offset, -back_plate_thickness / 2 - 0.02, lens_center_z])
    rotate([90, 0, 0])
      cylinder(h = back_plate_thickness + front_lip_depth + 0.9,
               d = lens_opening_diameter, center = true);

  // Cable/flex relief through the lower middle.
  front_cutout(cable_slot_width, cable_slot_height,
               back_plate_thickness + front_lip_depth + 0.8,
               0, lens_center_z - cradle_height / 2 + cable_slot_height / 2);

  // Drone frame M3 mounting holes, exactly 32.5 mm apart.
  through_hole(-frame_hole_spacing / 2, ear_center_z, frame_hole_diameter);
  through_hole(frame_hole_spacing / 2, ear_center_z, frame_hole_diameter);
}

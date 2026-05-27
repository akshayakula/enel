from math import sqrt


OUT = "arducam_zero_fpv_camera_mount.stl"

DX = 0.5
DZ = 0.5
Y_BACK = -1.5
Y_FRONT = 1.5

FRAME_HOLE_SPACING = 32.5
FRAME_HOLE_R = 1.7
EAR_R = 4.0
EAR_Z = 4.8

CRADLE_W = 63.0
CRADLE_Z0 = 5.05
CRADLE_Z1 = 18.55

LENS_R = 4.5
LENS_X = 0.0
LENS_Z = 11.8

CABLE_W = 18.0
CABLE_Z0 = 5.05
CABLE_Z1 = 9.55


def inside_circle(x, z, cx, cz, r):
    return (x - cx) ** 2 + (z - cz) ** 2 <= r ** 2


def in_rect(x, z, x0, x1, z0, z1):
    return x0 <= x <= x1 and z0 <= z <= z1


def solid_2d(x, z):
    in_cradle = in_rect(x, z, -CRADLE_W / 2, CRADLE_W / 2, CRADLE_Z0, CRADLE_Z1)
    in_ear = any(
        inside_circle(x, z, sx * FRAME_HOLE_SPACING / 2, EAR_Z, EAR_R)
        for sx in (-1, 1)
    )
    in_bridge = in_rect(x, z, -21.5, 21.5, 1.0, 7.2)
    if not (in_cradle or in_ear or in_bridge):
        return False

    in_mount_hole = any(
        inside_circle(x, z, sx * FRAME_HOLE_SPACING / 2, EAR_Z, FRAME_HOLE_R)
        for sx in (-1, 1)
    )
    in_lens = inside_circle(x, z, LENS_X, LENS_Z, LENS_R)
    in_cable = in_rect(x, z, -CABLE_W / 2, CABLE_W / 2, CABLE_Z0, CABLE_Z1)
    return not (in_mount_hole or in_lens or in_cable)


def normal(a, b, c):
    ux, uy, uz = (b[i] - a[i] for i in range(3))
    vx, vy, vz = (c[i] - a[i] for i in range(3))
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    mag = sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / mag, ny / mag, nz / mag


def tri(lines, a, b, c):
    nx, ny, nz = normal(a, b, c)
    lines.append(f"  facet normal {nx:.6f} {ny:.6f} {nz:.6f}")
    lines.append("    outer loop")
    for p in (a, b, c):
        lines.append(f"      vertex {p[0]:.3f} {p[1]:.3f} {p[2]:.3f}")
    lines.append("    endloop")
    lines.append("  endfacet")


def quad(lines, a, b, c, d):
    tri(lines, a, b, c)
    tri(lines, a, c, d)


def add_box(lines, x0, x1, y0, y1, z0, z1):
    p000 = (x0, y0, z0)
    p001 = (x0, y0, z1)
    p010 = (x0, y1, z0)
    p011 = (x0, y1, z1)
    p100 = (x1, y0, z0)
    p101 = (x1, y0, z1)
    p110 = (x1, y1, z0)
    p111 = (x1, y1, z1)
    quad(lines, p000, p100, p110, p010)
    quad(lines, p001, p011, p111, p101)
    quad(lines, p000, p001, p101, p100)
    quad(lines, p010, p110, p111, p011)
    quad(lines, p000, p010, p011, p001)
    quad(lines, p100, p101, p111, p110)


def main():
    xs = [round(-34.0 + i * DX, 4) for i in range(int((68.0) / DX))]
    zs = [round(0.0 + i * DZ, 4) for i in range(int((20.5) / DZ))]
    cells = set()
    for ix, x in enumerate(xs):
        for iz, z in enumerate(zs):
            if solid_2d(x + DX / 2, z + DZ / 2):
                cells.add((ix, iz))

    lines = ["solid arducam_zero_fpv_camera_mount"]
    for ix, iz in cells:
        x0, x1 = xs[ix], xs[ix] + DX
        z0, z1 = zs[iz], zs[iz] + DZ
        quad(lines, (x0, Y_BACK, z0), (x1, Y_BACK, z0), (x1, Y_BACK, z1), (x0, Y_BACK, z1))
        quad(lines, (x0, Y_FRONT, z0), (x0, Y_FRONT, z1), (x1, Y_FRONT, z1), (x1, Y_FRONT, z0))
        if (ix - 1, iz) not in cells:
            quad(lines, (x0, Y_BACK, z0), (x0, Y_BACK, z1), (x0, Y_FRONT, z1), (x0, Y_FRONT, z0))
        if (ix + 1, iz) not in cells:
            quad(lines, (x1, Y_BACK, z0), (x1, Y_FRONT, z0), (x1, Y_FRONT, z1), (x1, Y_BACK, z1))
        if (ix, iz - 1) not in cells:
            quad(lines, (x0, Y_BACK, z0), (x0, Y_FRONT, z0), (x1, Y_FRONT, z0), (x1, Y_BACK, z0))
        if (ix, iz + 1) not in cells:
            quad(lines, (x0, Y_BACK, z1), (x1, Y_BACK, z1), (x1, Y_FRONT, z1), (x0, Y_FRONT, z1))

    lip_y0, lip_y1 = -3.5, -1.5
    add_box(lines, -31.5, -28.5, lip_y0, lip_y1, 5.05, 18.55)
    add_box(lines, 28.5, 31.5, lip_y0, lip_y1, 5.05, 18.55)
    add_box(lines, -19.0, -7.0, lip_y0, lip_y1, 17.55, 19.55)
    add_box(lines, 7.0, 19.0, lip_y0, lip_y1, 17.55, 19.55)
    add_box(lines, -19.0, -7.0, lip_y0, lip_y1, 4.05, 6.05)
    add_box(lines, 7.0, 19.0, lip_y0, lip_y1, 4.05, 6.05)

    lines.append("endsolid arducam_zero_fpv_camera_mount")
    with open(OUT, "w", encoding="ascii") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()

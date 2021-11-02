async function grid2buffer(grid) {
    const [voc, vx, vy, vz] = await Promise.all([
        grid.getItem("vertex_of_cell").then(a => a.get()),
        grid.getItem("cartesian_x_vertices").then(a => a.get()).then(a => a.data),
        grid.getItem("cartesian_y_vertices").then(a => a.get()).then(a => a.data),
        grid.getItem("cartesian_z_vertices").then(a => a.get()).then(a => a.data)
    ]);

    const ncells = voc.shape[1];

    let verts = new Float32Array(ncells * 3 * 3);

    const vs0 = voc.get(0).data;
    const vs1 = voc.get(1).data;
    const vs2 = voc.get(2).data;

    for (var i = 0; i < ncells; i++) {
        let v0 = vs0[i] - 1;
        let v1 = vs1[i] - 1;
        let v2 = vs2[i] - 1;

        const a = new THREE.Vector3(vx[v0], vy[v0], vz[v0]);
        const b = new THREE.Vector3(vx[v1], vy[v1], vz[v1]);
        const c = new THREE.Vector3(vx[v2], vy[v2], vz[v2]);

        if (b.sub(a).cross(c.sub(a)).dot(a.add(b).add(c)) < 0) {
            [v1, v2] = [v2, v1];
        }

        verts[9 * i + 0] = vx[v0];
        verts[9 * i + 1] = vy[v0];
        verts[9 * i + 2] = vz[v0];

        verts[9 * i + 3] = vx[v1];
        verts[9 * i + 4] = vy[v1];
        verts[9 * i + 5] = vz[v1];

        verts[9 * i + 6] = vx[v2];
        verts[9 * i + 7] = vy[v2];
        verts[9 * i + 8] = vz[v2];
    }

    return verts;
}

async function data2value_buffer(data) {
    data = await data;
    const ncells = data.shape[0];
    const plotdata = await data.data

    let data_min = Number.POSITIVE_INFINITY;
    let data_max = Number.NEGATIVE_INFINITY;
    for (var i = 0; i < ncells; i++) {
        const v = plotdata[i];
        if (v < data_min) data_min = v;
        if (v > data_max) data_max = v;
    }

    const norm = d => (d - data_min) / (data_max - data_min);

    let data_values = new Float32Array(ncells * 3);

    for (var i = 0; i < ncells; i++) {
        const v = norm(plotdata[i]);
        data_values[3 * i + 0] = v;
        data_values[3 * i + 1] = v;
        data_values[3 * i + 2] = v;
    }
    return data_values;
}

async function data2color_buffer(data, colormap) {
    data = await data;
    const ncells = data.shape[0];
    const plotdata = await data.data

    const data_min = plotdata.reduce((a, b) => Math.min(a, b));
    const data_max = plotdata.reduce((a, b) => Math.max(a, b));

    let norm;
    if (colormap.endsWith('_r')) {
        colormap = colormap.substring(0, colormap.length - 2);
        norm = d => 1 - ((d - data_min) / (data_max - data_min));
    } else {
        norm = d => (d - data_min) / (data_max - data_min);
    }

    const colors = cm_data[colormap]["colors"];

    let color = new Float32Array(ncells * 3 * 3);

    for (var i = 0; i < ncells; i++) {
        const [r, g, b] = interpolated(norm(plotdata[i]), colors);

        color[9 * i + 0] = r;
        color[9 * i + 1] = g;
        color[9 * i + 2] = b;

        color[9 * i + 3] = r;
        color[9 * i + 4] = g;
        color[9 * i + 5] = b;

        color[9 * i + 6] = r;
        color[9 * i + 7] = g;
        color[9 * i + 8] = b;
    }

    return color;
}

function snapshot(canvas_id, render) {
    canvas = document.getElementById(canvas_id);
    render();
    canvas.toBlob(function(blob) {
        let link = document.createElement('a');
        link.download = 'gridlook.png';

        link.href = URL.createObjectURL(blob);
        link.click();

        // delete the internal blob reference, to let the browser clear memory from it
        URL.revokeObjectURL(link.href);
    }, 'image/png');
}

function make_colormap_material() {
    const vertexShader = `
        attribute float data_value;

        varying float v_value;

        void main() {
          v_value = data_value;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }
        `;

    const fragmentShader = `
        vec3 viridis(float t) {

            const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
            const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
            const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
            const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
            const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
            const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
            const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);

            return c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6)))));

        }

        varying float v_value;

        void main() {
          gl_FragColor.a = 1.0;
          gl_FragColor.rgb = viridis(v_value);
        }
        `;

    const material = new THREE.ShaderMaterial({
        uniforms: {

        },

        vertexShader,
        fragmentShader
    });
    return material;
}

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
        const v0 = vs0[i] - 1; 
        const v1 = vs1[i] - 1; 
        const v2 = vs2[i] - 1; 

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

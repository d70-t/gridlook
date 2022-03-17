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

    let data_min = Number.POSITIVE_INFINITY;
    let data_max = Number.NEGATIVE_INFINITY;
    for (var i = 0; i < ncells; i++) {
        const v = plotdata[i];
        if (v < data_min) data_min = v;
        if (v > data_max) data_max = v;
    }

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


const available_colormaps = {
    viridis: 0,
    plasma: 1,
    magma: 2,
    inferno: 3,
    turbo: 4,
    Blues: 5,
    coolwarm: 6,
};

function make_colormap_material(colormap="turbo", add_offset=0.0, scale_factor=1.0) {
    const vertexShader = `
        attribute float data_value;

        varying float v_value;

        void main() {
          v_value = data_value;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }
        `;

    // credits: https://www.shadertoy.com/view/3lBXR3
    //          https://github.com/mzucker/fit_colormaps
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

        vec3 plasma(float t) {

            const vec3 c0 = vec3(0.05873234392399702, 0.02333670892565664, 0.5433401826748754);
            const vec3 c1 = vec3(2.176514634195958, 0.2383834171260182, 0.7539604599784036);
            const vec3 c2 = vec3(-2.689460476458034, -7.455851135738909, 3.110799939717086);
            const vec3 c3 = vec3(6.130348345893603, 42.3461881477227, -28.51885465332158);
            const vec3 c4 = vec3(-11.10743619062271, -82.66631109428045, 60.13984767418263);
            const vec3 c5 = vec3(10.02306557647065, 71.41361770095349, -54.07218655560067);
            const vec3 c6 = vec3(-3.658713842777788, -22.93153465461149, 18.19190778539828);

            return c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6)))));

        }

        vec3 magma(float t) {

            const vec3 c0 = vec3(-0.002136485053939582, -0.000749655052795221, -0.005386127855323933);
            const vec3 c1 = vec3(0.2516605407371642, 0.6775232436837668, 2.494026599312351);
            const vec3 c2 = vec3(8.353717279216625, -3.577719514958484, 0.3144679030132573);
            const vec3 c3 = vec3(-27.66873308576866, 14.2647308096533, -13.64921318813922);
            const vec3 c4 = vec3(52.17613981234068, -27.94360607168351, 12.94416944238394);
            const vec3 c5 = vec3(-50.76852536473588, 29.04658282127291, 4.23415299384598);
            const vec3 c6 = vec3(18.65570506591883, -11.48977351997711, -5.601961508734096);

            return c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6)))));

        }

        vec3 inferno(float t) {

            const vec3 c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
            const vec3 c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
            const vec3 c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
            const vec3 c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
            const vec3 c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
            const vec3 c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
            const vec3 c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);

            return c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6)))));

        }

        vec3 turbo(float t) {

            const vec3 c0 = vec3(0.1140890109226559, 0.06288340699912215, 0.2248337216805064);
            const vec3 c1 = vec3(6.716419496985708, 3.182286745507602, 7.571581586103393);
            const vec3 c2 = vec3(-66.09402360453038, -4.9279827041226, -10.09439367561635);
            const vec3 c3 = vec3(228.7660791526501, 25.04986699771073, -91.54105330182436);
            const vec3 c4 = vec3(-334.8351565777451, -69.31749712757485, 288.5858850615712);
            const vec3 c5 = vec3(218.7637218434795, 67.52150567819112, -305.2045772184957);
            const vec3 c6 = vec3(-52.88903478218835, -21.54527364654712, 110.5174647748972);

            return c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6)))));

        }

        vec3 Blues(float t) {    
                                                                                                  
            const vec3 coeffs0 = vec3(0.9786010101212481, 0.9875444398085995, 0.9995488674928417);    
            const vec3 coeffs1 = vec3(-1.413783133703736, -0.6613965253505383, -0.2551967459427577);    
            const vec3 coeffs2 = vec3(8.196156393822546, 1.537863247504115, 0.3908546698678254);    
            const vec3 coeffs3 = vec3(-37.00985967929134, -4.714620284418913, -2.794839680508977);    
            const vec3 coeffs4 = vec3(66.47062932522077, 4.252799105471284, 4.973946475421295);    
            const vec3 coeffs5 = vec3(-53.98400061794709, -0.9317365997486859, -3.342587866202619);    
            const vec3 coeffs6 = vec3(16.80709019184263, -0.2875407176076939, 0.4316330565156698);    
                                                                                                     
            return coeffs0+t*(coeffs1+t*(coeffs2+t*(coeffs3+t*(coeffs4+t*(coeffs5+t*coeffs6)))));    
             
        }

        vec3 coolwarm(float t) { 
                                                                                                          
            const vec3 coeffs0 = vec3(0.2284927239464558, 0.2890337657614808, 0.7544508730405812);    
            const vec3 coeffs1 = vec3(1.209148543573963, 2.308782797929739, 1.565018051709207);         
            const vec3 coeffs2 = vec3(0.09440683758290924, -7.335911877741697, -1.889871770155974); 
            const vec3 coeffs3 = vec3(2.267155723842107, 32.60337423142011, -1.604197978482374);      
            const vec3 coeffs4 = vec3(-5.211327179232611, -75.84718811546922, -3.80065988450061);  
            const vec3 coeffs5 = vec3(1.4422071109688, 74.23835765282, 9.761545722360259);             
            const vec3 coeffs6 = vec3(0.6730757561376177, -26.24251233104311, -4.645203112066666);    
                                                                                                     
            return coeffs0+t*(coeffs1+t*(coeffs2+t*(coeffs3+t*(coeffs4+t*(coeffs5+t*coeffs6)))));    
             
        }

        varying float v_value;
        uniform float add_offset;
        uniform float scale_factor;
        uniform int colormap;

        void main() {
          gl_FragColor.a = 1.0;
          if (colormap == 0) {
              gl_FragColor.rgb = viridis(add_offset + scale_factor * v_value);
          } else if (colormap == 1) {
              gl_FragColor.rgb = plasma(add_offset + scale_factor * v_value);
          } else if (colormap == 2) {
              gl_FragColor.rgb = magma(add_offset + scale_factor * v_value);
          } else if (colormap == 3) {
              gl_FragColor.rgb = inferno(add_offset + scale_factor * v_value);
          } else if (colormap == 4) {
              gl_FragColor.rgb = turbo(add_offset + scale_factor * v_value);
          } else if (colormap == 5) {
              gl_FragColor.rgb = Blues(add_offset + scale_factor * v_value);
          } else if (colormap == 6) {
              gl_FragColor.rgb = coolwarm(add_offset + scale_factor * v_value);
          }
        }
        `;

    const material = new THREE.ShaderMaterial({
        uniforms: {
            add_offset: { value: add_offset },
            scale_factor: { value: scale_factor },
            colormap: { value: available_colormaps[colormap] },
        },

        vertexShader,
        fragmentShader
    });
    return material;
}

class ChunkedGrid {

}

class RenderableChunk {
    constructor() {
        this.grid_chunk = undefined;

        this.material = make_colormap_material("turbo", 1.0, -1.0);
        this._geometry = undefined;
    }

    async get_geometry() {
        if ( this._geometry === undefined ) {
            let done = undefined;
            let fail = undefined;
            this._geometry = new Promise((resolve, reject) => {
                done = resolve;
                fail = reject;
            });

            const [verts, values] = await Promise.all([
                this.grid_chunk.get_verts(),
                this.get_value_buffer(),
            ]);

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute( 'position', new THREE.BufferAttribute( verts, 3 ) );
            geometry.setAttribute( 'data_value', new THREE.BufferAttribute( values, 1 ) );
            done(geometry);
        }
        return await this._geometry;
    }

    add_to(scene) {
        const mesh = new THREE.Mesh( geometry, this.material );
        scene.add(mesh);
    }
}

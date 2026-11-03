const net = require('net');

// RTSP proxy that relays a camera's RTSP-over-TCP session unchanged, except that it
// drops H.264 NAL units UniFi Protect cannot restream. Amcrest/Dahua cameras put an
// access unit delimiter (9) and an SEI (6) in front of every frame; Protect's 7447
// restream turns the AUD into an empty RTP packet and fuses the SEI with the slice
// into one NAL that keeps the SEI type, so clients never decode a picture.
// RTP sequence numbers are renumbered so the client does not see packet loss.

const DROP_NAL_TYPES = [6, 9];

class RtspSession {
    constructor(client, targetHost, targetPort) {
        this.client = client;
        this.h264PayloadTypes = new Set();
        this.dropped = {};
        this.buffer = Buffer.alloc(0);

        this.upstream = net.connect(targetPort, targetHost);
        this.client.pipe(this.upstream);
        this.upstream.on('data', (data) => this.onUpstreamData(data));

        const close = () => {
            this.client.destroy();
            this.upstream.destroy();
        };
        this.client.on('error', close);
        this.client.on('close', close);
        this.upstream.on('error', close);
        this.upstream.on('close', close);
    }

    onUpstreamData(data) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
        let out = [];
        let offset = 0;

        while (offset < this.buffer.length) {
            let consumed;
            if (this.buffer[offset] == 0x24)
                consumed = this.handleInterleaved(offset, out);
            else
                consumed = this.handleResponse(offset, out);
            if (consumed == 0)
                break;
            offset += consumed;
        }

        this.buffer = this.buffer.subarray(offset);
        if (out.length)
            this.client.write(out.length == 1 ? out[0] : Buffer.concat(out));
    }

    handleInterleaved(offset, out) {
        if (this.buffer.length - offset < 4)
            return 0;
        let channel = this.buffer[offset + 1];
        let length = this.buffer.readUInt16BE(offset + 2);
        if (this.buffer.length - offset < 4 + length)
            return 0;

        let frame = this.buffer.subarray(offset, offset + 4 + length);
        if (channel % 2 == 0 && length > 12 && this.h264PayloadTypes.has(frame[5] & 0x7f)) {
            let headerLength = 12 + 4 * (frame[4] & 0x0f);
            if (frame[4] & 0x10)
                headerLength += 4 + 4 * frame.readUInt16BE(4 + headerLength + 2);
            let nalType = 4 + headerLength < frame.length ? frame[4 + headerLength] & 0x1f : -1;

            if (DROP_NAL_TYPES.includes(nalType)) {
                this.dropped[channel] = (this.dropped[channel] || 0) + 1;
                return 4 + length;
            }
            if (this.dropped[channel]) {
                frame = Buffer.from(frame);
                frame.writeUInt16BE((frame.readUInt16BE(6) - this.dropped[channel]) & 0xffff, 6);
            }
        }

        out.push(frame);
        return 4 + length;
    }

    handleResponse(offset, out) {
        let headerEnd = this.buffer.indexOf('\r\n\r\n', offset);
        if (headerEnd < 0)
            return 0;
        let header = this.buffer.toString('latin1', offset, headerEnd);
        let match = header.match(/\r\nContent-Length:\s*(\d+)/i);
        let total = headerEnd + 4 - offset + (match ? parseInt(match[1]) : 0);
        if (this.buffer.length - offset < total)
            return 0;

        let body = this.buffer.toString('latin1', headerEnd + 4, offset + total);
        for (let rtpmap of body.matchAll(/a=rtpmap:(\d+)\s+H264\//gi))
            this.h264PayloadTypes.add(parseInt(rtpmap[1]));

        out.push(this.buffer.subarray(offset, offset + total));
        return total;
    }
}

function createProxy(port, targetHost, targetPort) {
    return net.createServer((client) => {
        new RtspSession(client, targetHost, targetPort);
    }).listen(port);
}

exports.createProxy = createProxy;

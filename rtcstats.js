/* eslint-disable prefer-rest-params */
/* eslint-disable no-param-reassign */
import { BrowserDetection } from '@jitsi/js-utils';

/**
 * transforms a maplike to an object. Mostly for getStats + JSON.parse(JSON.stringify())
 * @param {*} m
 */
function map2obj(m) {
    if (!m.entries) {
        return m;
    }
    const o = {};

    m.forEach((v, k) => {
        o[k] = v;
    });

    return o;
}

/**
 * Apply a delta compression to the stats report. Reduces size by ~90%.
 * To reduce further, report keys could be compressed.
 * @param {*} oldStats
 * @param {*} newStats
 */
function deltaCompression(oldStats, newStatsArg) {
    const newStats = JSON.parse(JSON.stringify(newStatsArg));

    Object.keys(newStats).forEach(id => {
        const report = newStats[id];

        delete report.id;
        if (!oldStats[id]) {
            return;
        }
        Object.keys(report).forEach(name => {
            if (report[name] === oldStats[id][name]) {
                delete newStats[id][name];
            }
            if (Object.keys(report).length === 0) {
                delete newStats[id];
            } else if (Object.keys(report).length === 1 && report.timestamp) {
                delete newStats[id];
            }
        });
    });

    let timestamp = -Infinity;

    Object.keys(newStats).forEach(id => {
        const report = newStats[id];

        if (report.timestamp > timestamp) {
            timestamp = report.timestamp;
        }
    });
    Object.keys(newStats).forEach(id => {
        const report = newStats[id];

        if (report.timestamp === timestamp) {
            report.timestamp = 0;
        }
    });
    newStats.timestamp = timestamp;

    return newStats;
}

/**
 *
 * @param {*} pc
 * @param {*} response
 */
function mangleChromeStats(pc, response) {
    const standardReport = {};
    const reports = response.result();

    reports.forEach(report => {
        const standardStats = {
            id: report.id,
            timestamp: report.timestamp.getTime(),
            type: report.type
        };

        report.names().forEach(name => {
            standardStats[name] = report.stat(name);
        });
        standardReport[standardStats.id] = standardStats;
    });

    return standardReport;
}

/**
 *
 * @param {*} stream
 */
function dumpStream(stream) {
    return {
        id: stream.id,
        tracks: stream.getTracks().map(track => {
            return {
                id: track.id, // unique identifier (GUID) for the track
                kind: track.kind, // `audio` or `video`
                label: track.label, // identified the track source
                enabled: track.enabled, // application can control it
                muted: track.muted, // application cannot control it (read-only)
                readyState: track.readyState // `live` or `ended`
            };
        })
    };
}

/*
function filterBoringStats(results) {
  Object.keys(results).forEach(function(id) {
    switch (results[id].type) {
      case 'certificate':
      case 'codec':
        delete results[id];
        break;
      default:
        // noop
    }
  });
  return results;
}

function removeTimestamps(results) {
  // FIXME: does not work in FF since the timestamp can't be deleted.
  Object.keys(results).forEach(function(id) {
    delete results[id].timestamp;
  });
  return results;
}
*/

/**
 *
 * @param {*} trace
 * @param {*} getStatsInterval
 * @param {*} prefixesToWrap
 * @param {*} connectionFilter
 */
export default function(trace, getStatsInterval, prefixesToWrap, connectionFilter) {
    let peerconnectioncounter = 0;

    const browserDetection = new BrowserDetection();
    const isFirefox = browserDetection.isFirefox();
    const isSafari = browserDetection.isSafari();
    const isChrome = browserDetection.isChrome();
    const isElectron = browserDetection.isElectron();

    // Only initialize rtcstats if it's run in a supported browser
    if (!(isFirefox || isSafari || isChrome || isElectron)) {
        throw new Error('RTCStats unsupported browser.');
    }

    prefixesToWrap.forEach(prefix => {
        if (!window[`${prefix}RTCPeerConnection`]) {
            return;
        }

        const OrigPeerConnection = window[`${prefix}RTCPeerConnection`];
        const peerconnection = function(config, constraints) {
            // We want to make sure that any potential errors that occur at this point, caused by rtcstats logic,
            // does not affect the normal flow of any application that might integrate it.
            const origConfig = { ...config };
            const origConstraints = { ...constraints };

            try {
                const pc = new OrigPeerConnection(config, constraints);

                // In case the client wants to skip some rtcstats connections, a filter function can be provided which
                // will return the original PC object without any strings attached.
                if (connectionFilter && connectionFilter(config)) {
                    return pc;
                }

                const id = `PC_${peerconnectioncounter++}`;

                pc.__rtcStatsId = id;

                if (!config) {
                    config = { nullConfig: true };
                }

                config = JSON.parse(JSON.stringify(config)); // deepcopy
                // don't log credentials
                ((config && config.iceServers) || []).forEach(server => {
                    delete server.credential;
                });

                if (isFirefox) {
                    config.browserType = 'moz';
                } else {
                    config.browserType = 'webkit';
                }

                trace('create', id, config);

                // TODO: do we want to log constraints here? They are chrome-proprietary.
                // eslint-disable-next-line max-len
                // http://stackoverflow.com/questions/31003928/what-do-each-of-these-experimental-goog-rtcpeerconnectionconstraints-do
                if (constraints) {
                    trace('constraints', id, constraints);
                }

                pc.addEventListener('icecandidate', e => {
                    trace('onicecandidate', id, e.candidate);
                });
                pc.addEventListener('addstream', e => {
                    trace('onaddstream', id, `${e.stream.id} ${e.stream.getTracks().map(t => `${t.kind}:${t.id}`)}`);
                });
                pc.addEventListener('track', e => {
                    trace(
                        'ontrack',
                        id,
                        `${e.track.kind}:${e.track.id} ${e.streams.map(stream => `stream:${stream.id}`)}`
                    );
                });
                pc.addEventListener('removestream', e => {
                    trace(
                        'onremovestream',
                        id,
                        `${e.stream.id} ${e.stream.getTracks().map(t => `${t.kind}:${t.id}`)}`
                    );
                });
                pc.addEventListener('signalingstatechange', () => {
                    trace('onsignalingstatechange', id, pc.signalingState);
                });
                pc.addEventListener('iceconnectionstatechange', () => {
                    trace('oniceconnectionstatechange', id, pc.iceConnectionState);
                });
                pc.addEventListener('icegatheringstatechange', () => {
                    trace('onicegatheringstatechange', id, pc.iceGatheringState);
                });
                pc.addEventListener('connectionstatechange', () => {
                    trace('onconnectionstatechange', id, pc.connectionState);
                });
                pc.addEventListener('negotiationneeded', () => {
                    trace('onnegotiationneeded', id, undefined);
                });
                pc.addEventListener('datachannel', event => {
                    trace('ondatachannel', id, [ event.channel.id, event.channel.label ]);
                });

                let prev = {};
                const getStats = function() {
                    if (isFirefox || isSafari) {
                        pc.getStats(null).then(res => {
                            const now = map2obj(res);
                            const base = JSON.parse(JSON.stringify(now)); // our new prev

                            trace('getstats', id, deltaCompression(prev, now));
                            prev = base;
                        });
                    } else {
                        pc.getStats(res => {
                            const now = mangleChromeStats(pc, res);
                            const base = JSON.parse(JSON.stringify(now)); // our new prev

                            trace('getstats', id, deltaCompression(prev, now));
                            prev = base;
                        });
                    }
                };

                // TODO: do we want one big interval and all peerconnections
                //    queried in that or one setInterval per PC?
                //    we have to collect results anyway so...
                if (getStatsInterval) {
                    const interval = window.setInterval(() => {
                        if (pc.signalingState === 'closed') {
                            window.clearInterval(interval);

                            return;
                        }
                        getStats();
                    }, getStatsInterval);
                }

                pc.addEventListener('iceconnectionstatechange', () => {
                    if (pc.iceConnectionState === 'connected') {
                        getStats();
                    }
                });

                return pc;
            } catch (error) {
                // If something went wrong, return a normal PeerConnection
                console.error('RTCStats PeerConnection bind failed: ', error);

                return new OrigPeerConnection(origConfig, origConstraints);
            }
        };

        [ 'createDataChannel', 'close' ].forEach(method => {
            const nativeMethod = OrigPeerConnection.prototype[method];

            if (nativeMethod) {
                OrigPeerConnection.prototype[method] = function() {
                    try {
                        trace(method, this.__rtcStatsId, arguments);
                    } catch (error) {
                        console.error(`RTCStats ${method} bind failed: `, error);
                    }

                    return nativeMethod.apply(this, arguments);
                };
            }
        });

        [ 'addStream', 'removeStream' ].forEach(method => {
            const nativeMethod = OrigPeerConnection.prototype[method];

            if (nativeMethod) {
                OrigPeerConnection.prototype[method] = function() {
                    try {
                        const stream = arguments[0];
                        const streamInfo = stream
                            .getTracks()
                            .map(t => `${t.kind}:${t.id}`)
                            .join(',');

                        trace(method, this.__rtcStatsId, `${stream.id} ${streamInfo}`);
                    } catch (error) {
                        console.error(`RTCStats ${method} bind failed: `, error);
                    }

                    return nativeMethod.apply(this, arguments);
                };
            }
        });

        [ 'addTrack' ].forEach(method => {
            const nativeMethod = OrigPeerConnection.prototype[method];

            if (nativeMethod) {
                OrigPeerConnection.prototype[method] = function() {
                    try {
                        const track = arguments[0];
                        const streams = [].slice.call(arguments, 1);

                        trace(
                            method,
                            this.__rtcStatsId,
                            `${track.kind}:${track.id} ${streams.map(s => `stream:${s.id}`).join(';') || '-'}`
                        );
                    } catch (error) {
                        console.error(`RTCStats ${method} bind failed: `, error);
                    }

                    return nativeMethod.apply(this, arguments);
                };
            }
        });

        [ 'removeTrack' ].forEach(method => {
            const nativeMethod = OrigPeerConnection.prototype[method];

            if (nativeMethod) {
                OrigPeerConnection.prototype[method] = function() {
                    try {
                        const track = arguments[0].track;

                        trace(method, this.__rtcStatsId, track ? `${track.kind}:${track.id}` : 'null');
                    } catch (error) {
                        console.error(`RTCStats ${method} bind failed: `, error);
                    }

                    return nativeMethod.apply(this, arguments);
                };
            }
        });

        [ 'createOffer', 'createAnswer' ].forEach(method => {
            const nativeMethod = OrigPeerConnection.prototype[method];

            if (nativeMethod) {
                OrigPeerConnection.prototype[method] = function() {
                    // The logic here extracts the arguments and establishes if the API
                    // is callback or Promise based.
                    const rtcStatsId = this.__rtcStatsId;
                    const args = arguments;
                    let opts;

                    if (arguments.length === 1 && typeof arguments[0] === 'object') {
                        opts = arguments[0];
                    } else if (arguments.length === 3 && typeof arguments[2] === 'object') {
                        opts = arguments[2];
                    }

                    // We can only put a "barrier" at this point because the above logic is
                    // necessary in all cases, if something fails there we can't just bypass it.
                    try {
                        trace(method, this.__rtcStatsId, opts);
                    } catch (error) {
                        console.error(`RTCStats ${method} bind failed: `, error);
                    }

                    return nativeMethod.apply(this, opts ? [ opts ] : undefined).then(
                        description => {
                            try {
                                trace(`${method}OnSuccess`, rtcStatsId, description);
                            } catch (error) {
                                console.error(`RTCStats ${method} promise success bind failed: `, error);
                            }

                            // We can't safely bypass this part of logic because it's necessary for Proxying this
                            // request. It determines weather the call is callback or promise based.
                            if (args.length > 0 && typeof args[0] === 'function') {
                                args[0].apply(null, [ description ]);

                                return undefined;
                            }

                            return description;
                        },
                        err => {
                            try {
                                trace(`${method}OnFailure`, rtcStatsId, err.toString());
                            } catch (error) {
                                console.error(`RTCStats ${method} promise failure bind failed: `, error);
                            }

                            // We can't safely bypass this part of logic because it's necessary for
                            // Proxying this request. It determines weather the call is callback or promise based.
                            if (args.length > 1 && typeof args[1] === 'function') {
                                args[1].apply(null, [ err ]);

                                return;
                            }
                            throw err;
                        }
                    );
                };
            }
        });

        [ 'setLocalDescription', 'setRemoteDescription', 'addIceCandidate' ].forEach(method => {
            const nativeMethod = OrigPeerConnection.prototype[method];

            if (nativeMethod) {
                OrigPeerConnection.prototype[method] = function() {
                    const rtcStatsId = this.__rtcStatsId;
                    const args = arguments;

                    try {
                        trace(method, this.__rtcStatsId, args[0]);
                    } catch (error) {
                        console.error(`RTCStats ${method} bind failed: `, error);
                    }

                    return nativeMethod.apply(this, [ args[0] ]).then(
                        () => {
                            try {
                                trace(`${method}OnSuccess`, rtcStatsId, undefined);
                            } catch (error) {
                                console.error(`RTCStats ${method} promise success bind failed: `, error);
                            }

                            // We can't safely bypass this part of logic because it's necessary for
                            // Proxying this request. It determines weather the call is callback or promise based.
                            if (args.length >= 2 && typeof args[1] === 'function') {
                                args[1].apply(null, []);

                                return undefined;
                            }

                            return undefined;
                        },
                        err => {
                            try {
                                trace(`${method}OnFailure`, rtcStatsId, err.toString());
                            } catch (error) {
                                console.error(`RTCStats ${method} promise failure bind failed: `, error);
                            }

                            // We can't safely bypass this part of logic because it's necessary for
                            // Proxying this request. It determines weather the call is callback or promise based
                            if (args.length >= 3 && typeof args[2] === 'function') {
                                args[2].apply(null, [ err ]);

                                return undefined;
                            }
                            throw err;
                        }
                    );
                };
            }
        });

        // wrap static methods. Currently just generateCertificate.
        if (OrigPeerConnection.generateCertificate) {
            Object.defineProperty(peerconnection, 'generateCertificate', {
                get() {
                    return arguments.length
                        ? OrigPeerConnection.generateCertificate.apply(null, arguments)
                        : OrigPeerConnection.generateCertificate;
                }
            });
        }
        window[`${prefix}RTCPeerConnection`] = peerconnection;
        window[`${prefix}RTCPeerConnection`].prototype = OrigPeerConnection.prototype;
    });

    // getUserMedia wrappers
    prefixesToWrap.forEach(prefix => {
        const name = prefix + (prefix.length ? 'GetUserMedia' : 'getUserMedia');

        if (!navigator[name]) {
            return;
        }
        const origGetUserMedia = navigator[name].bind(navigator);
        const gum = function() {
            try {
                trace('getUserMedia', null, arguments[0]);
            } catch (error) {
                console.error('RTCStats getUserMedia bind failed: ', error);
            }

            const cb = arguments[1];
            const eb = arguments[2];

            origGetUserMedia(
                arguments[0],
                stream => {
                    try {
                        trace('getUserMediaOnSuccess', null, dumpStream(stream));
                    } catch (error) {
                        console.error('RTCStats getUserMediaOnSuccess bind failed: ', error);
                    }

                    // we log the stream id, track ids and tracks readystate since that is ended GUM fails
                    // to acquire the cam (in chrome)
                    if (cb) {
                        cb(stream);
                    }
                },
                err => {
                    try {
                        trace('getUserMediaOnFailure', null, err.name);
                    } catch (error) {
                        console.error('RTCStats getUserMediaOnFailure bind failed: ', error);
                    }

                    if (eb) {
                        eb(err);
                    }
                }
            );
        };

        navigator[name] = gum.bind(navigator);
    });

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        const gum = function() {
            try {
                trace('navigator.mediaDevices.getUserMedia', null, arguments[0]);
            } catch (error) {
                console.error('RTCStats navigator.mediaDevices.getUserMedia bind failed: ', error);
            }

            return origGetUserMedia.apply(navigator.mediaDevices, arguments).then(
                stream => {
                    try {
                        trace('navigator.mediaDevices.getUserMediaOnSuccess', null, dumpStream(stream));
                    } catch (error) {
                        console.error('RTCStats navigator.mediaDevices.getUserMediaOnSuccess bind failed: ', error);
                    }

                    return stream;
                },
                err => {
                    try {
                        trace('navigator.mediaDevices.getUserMediaOnFailure', null, err.name);
                    } catch (error) {
                        console.error('RTCStats navigator.mediaDevices.getUserMediaOnFailure bind failed: ', error);
                    }

                    return Promise.reject(err);
                }
            );
        };

        navigator.mediaDevices.getUserMedia = gum.bind(navigator.mediaDevices);
    }

    // getDisplayMedia
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        const gdm = function() {
            try {
                trace('navigator.mediaDevices.getDisplayMedia', null, arguments[0]);
            } catch (error) {
                console.error('RTCStats navigator.mediaDevices.getDisplayMedia bind failed: ', error);
            }

            return origGetDisplayMedia.apply(navigator.mediaDevices, arguments).then(
                stream => {
                    try {
                        trace('navigator.mediaDevices.getDisplayMediaOnSuccess', null, dumpStream(stream));
                    } catch (error) {
                        console.error('RTCStats navigator.mediaDevices.getDisplayMediaOnSuccess bind failed: ', error);
                    }

                    return stream;
                },
                err => {
                    try {
                        trace('navigator.mediaDevices.getDisplayMediaOnFailure', null, err.name);
                    } catch (error) {
                        console.error('RTCStats navigator.mediaDevices.getDisplayMediaOnFailure bind failed: ', error);
                    }

                    return Promise.reject(err);
                }
            );
        };

        navigator.mediaDevices.getDisplayMedia = gdm.bind(navigator.mediaDevices);
    }

    // TODO: are there events defined on MST that would allow us to listen when enabled was set?
    //    no :-(
    /*
    Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
      set: function(value) {
        trace('MediaStreamTrackEnable', this, value);
      }
     });
    */
}

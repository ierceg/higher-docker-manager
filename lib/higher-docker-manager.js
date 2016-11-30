
'use strict';

const _ = require('lodash');
const Docker = require('node-docker-api').Docker;
const os = require('os');
const selectn = require('selectn');

const docker = new Docker({
    socketPath: '/var/run/docker.sock'
});

//  According to https://docs.docker.com/engine/reference/api/docker_remote_api_v1.24/#/attach-to-a-container
const DOCKER_OUTPUT_HEADER_FRAME_TYPE_INDEX = 0;
const DOCKER_OUTPUT_HEADER_FRAME_SIZE_INDEX = 4;
const PAYLOAD_HEADER_SIZE = 8;
const DOCKER_OUTPUT_PAYLOAD_INDEX = PAYLOAD_HEADER_SIZE;

const promisifyStream = (stream) => new Promise((resolve, reject) => {
    stream.on('data', (d) => { /* do nothing - we need to accept the data showing progress */});
    stream.on('end', resolve);
    stream.on('error', reject);
});

//  Keep running the promises returned by the given action while the given condition returns true.
const asyncWhile = (condition, action) => {
    let whilst = () => {
        return condition() ? action().then(whilst) : Promise.resolve();
    };

    return whilst();
};

/**
 * HigherDockerManager class offers functions to manage docker images, volumes and
 * containers.
 */
class HigherDockerManager {
    /**
     * Registers image with the given name and tag with Docker.
     * @param {string} name Name of the image to be pulled from Docker registry
     * @param {string} tag Tag of the image to be pulled from Docker registry
     * @return {Promise} Promise returning pulled image
     */
    static pullImage(name, tag) {
        return docker.image.create({}, {fromImage: name, tag: tag})
            .then((stream) => promisifyStream(stream))
            .then(() => docker.image.status(name + ':' + tag));
    }

    /**
     * Returns container in which the process is running. If the process is not in a container
     * then null is returned.
     * @return {Promise} Promise resolving with the process's container or null.
     */
    static getOwnContainer() {
        const hostname = os.hostname();

        return docker.container
            .list()
            .then((containers) => {
                let i = 0;
                let ownContainer = null;
                return asyncWhile(
                    () => i < containers.length && _.isNull(ownContainer),
                    () => {
                        const container = containers[i];
                        return container.status()
                            .then((data) => {
                                if (selectn('Config.Hostname', data) === hostname) {
                                    ownContainer = container;
                                }

                                ++i;
                            });
                    })
                    .then(() => {
                        return ownContainer;
                    });
            });
    }

    /**
     * Returns containers that are on the given networks.
     * @param {Array|Object} networks Array of network names or Networks Docker JSON as returned by
     * `status` function.
     * @return {Promise} Promise resolving with array of matching containers which may be empty.
     */
    static getContainersInNetworks(networks) {
        //  We accept Networks object as it's returned by status(). In that case we
        //  only care about the names of the networks and not their properties.
        if (_.isObject(networks)) {
            networks = _.keys(networks);
        }

        return docker.container
            .list()
            .then((containers) => {
                //  Retrieve status of all the containers and compare their networks to
                //  the given collection of network names. This is performed in parallel.
                return Promise.all(_.map(containers, (container) => {
                    return container.status()
                        //  Get networks.
                        .then(_.curry(selectn)('NetworkSettings.Networks'))
                        //  Remove falsy items (e.g. containers with no networks?)
                        .then(_.filter)
                        //  Get network names.
                        .then(_.keys)
                        //  Compare network names with the given network names.
                        .then(_.curry(_.some, _,
                            (containerNetworkName) => _.some(networks, containerNetworkName)))
                        //  If any networks matched, return the container.
                        .then((match) => {
                            if (match) {
                                return container;
                            }
                        })
                }));
            })
            //  Remove falsy items from the resulting collection.
            .then(_.filter);
    }

    /**
     * Creates unique data volume for the given user.
     * @param {string} volumeName Name of the volume to be created
     * @return {Promise} Promise returning created volume
     */
    static createVolume(volumeName) {
        return docker.volume.create({name: volumeName});
    }

    /**
     * Runs a temporary container with the given parameters, waits for its execution
     * to end and returns its output as an array of buffers.
     * @param {Object} params Parameters with which to run a temporary container
     * @return {Promise} Primise returning the output of the run in an array of buffers.
     */
    static runTemporaryContainer(params) {
        //  Reference to temporary container that we will use for all the operations
        //  once the container has been created.
        let temporaryContainer = null;

        /**
         * Schedules and performs the cleanup after the analysis. This operation doesn't
         * fail as there is nothing we can do about failed cleanup. The cleanup is
         * delayed as it is noop from the point of view of the analysis and we want
         * to return the results as soon as possible.
         */
        const scheduleDelayedCleanup = () => {
            setImmediate(() => {
                if (!temporaryContainer) {
                    return;
                }

                //  Just in case wait for the container to finish before trying to delete it.
                temporaryContainer.wait()
                    .then(() => temporaryContainer.delete())
                    .catch((err) => {
                        logger.error('Failed to delete temporary container', err);
                        //  Don't pass on this error - there is nothing we can do about it.
                    });
            });
        };

        return docker.container.create(params)
            .then((container) => {
                temporaryContainer = container;
                temporaryContainer.start();
            })
            .then(() => temporaryContainer.wait())
            .then(() => temporaryContainer.logs({
                follow: true,
                stdout: true,
                stderr: true
            }))
            .then(HigherDockerManager._processContainerOutputStream)
            .then((results) => {
                //  Schedule the cleanup and pass on the results.
                scheduleDelayedCleanup();
                return results;
            })
            .catch((err) => {
                logger.error('Failed to start or run temporary container', err);
                //  Schedule the cleanup and pass on the error.
                scheduleDelayedCleanup();
                return Promise.reject(err);
            });
    }

    /**
     * Runs container with the given parameters.
     * @param {Object} params Parameters for running a new container.
     * @return {Promise} Promise fulfilled once new container has been started.
     */
    static runContainer(params) {
        return docker.container.create(params)
            .then((container) => {
                return container.start();
            });
    }

    /**
     * Searches for the container with the given name or ID.
     * @param {string} containerNameOrId The name or ID of the container for which we are searching
     * @return {Promise} Promise returning the found container if any
     */
    static getContainerForNameOrId(containerNameOrId) {
        return docker.container
            .list()
            .then(HigherDockerManager.findContainerForNameOrId);
    }

    /**
     * Finds the container with the given name or ID in the given containers collection.
     * @param {Array} containers Array of containers in which to try to find the container.
     * @param {string} containerNameOrId The name or ID of the container for which we are searching.
     * @return {container} Found container if it was found, otherwise `null`.
     */
    static findContainerForNameOrId(containers, containerNameOrId) {
        //  Find the container that matches with its ID or one of its names.
        return _.find(containers, (container) => {
            //  Docker prefixes all container names with `/`.
            const prefixedContainerName = '/' + containerNameOrId;
            return container.id === containerNameOrId
                || _.some(container.Names, (name) => name === prefixedContainerName);
        }) || null;
    }

    /**
     * Searches for all the containers with the given image name.
     * @param {string} imageName The name of the image including the tag for which we are searching
     * @return {Promise} Promise resolving with the array of matching containers.
     */
    static getContainersForImage(imageName) {
        return docker.container
            .list()
            .then(HigherDockerManager.filterContainersByImage);
    }

    /**
     * Filters all containers with the given image name in the given collection of containers.
     * @param {Array} containers Array of containers which is being filtered.
     * @param {string} imageName The name of the image including the tag for which we are searching
     * @return {Array} Array of matching containers.
     */
    static filterContainersByImage(containers, imageName) {
        return _.filter(containers, (container) => container.Image === imageName);
    }

    /**
     * Searches for all the containers with the given label name and value
     * @param {string} labelName The name of the label which we are searching
     * @param {string} labelValue The value of the lable which we are searching
     * @return {Promise} Promise resolving with the array of found containers.
     */
    static getContainersForLabel(labelName, labelValue) {
        return docker.container
            .list()
            .then(HigherDockerManager.filterContainersByLabel);
    }

    /**
     * Filters all the containers with the given label name and value in the given collection of
     * containers.
     * @param {Array} containers Array of containers which is being filtered.
     * @param {string} labelName The name of the label which we are filtering.
     * @param {string} labelValue The value of the lable which we are filtering.
     * @return {Array} Array of matching containers.
     */
    static filterContainersByLabel(containers, labelName, labelValue) {
        return _.filter(containers,
            (container) => _.some(container.Labels,
                (value, name) => {
                    return name === labelName && value === labelValue;
                }));
    }

    /**
     * Executes a command in an already running container.
     * @param {Container} container Docker container object on which to execute the command
     * @param {object} params Parameters of the execution
     * @return {Promise} Promise returning the output of the execution
     */
    static execInContainer(container, params) {
        return container.exec.create(_.extend(params, {
            AttachStdout: true,
            AttachStderr: true
        }))
            .then((exec) => {
                return exec.start({
                    Detach: false
                });
            })
            .then(HigherDockerManager._processContainerOutputStream);
    }

    /**
     * Processes the output stream of a container.
     * @param {stream} stream Output stream of a container.
     * @return {Promise} Promise returning array of outputs
     * @private
     */
    static _processContainerOutputStream(stream) {
        return new Promise((resolve, reject) => {
            const buffers = [];
            stream.on('data', (buffer) => {
                buffers.push(buffer);
            });
            stream.on('end', () => {
                resolve(buffers);
            });
            stream.on('error', reject);
        })
            .then(HigherDockerManager._processContainerOutputBuffers);
    }

    /**
     * Processes the array of output buffers from a container.
     * @param {Array} buffers Array of buffers with container output per Docker's format
     * @return {Array} Array of objects with type, size and payload of each container output
     * @private
     */
    static _processContainerOutputBuffers(buffers) {
        return _
            .chain(buffers)
            .map((buffer) => {
                if (!Buffer.isBuffer(buffer) || buffer.length < PAYLOAD_HEADER_SIZE) {
                    logger.error('Bad container output', buffer);
                    return [];
                }

                //  Sometimes a single buffer contains more than one payload.
                const payloads = [];
                let currentIndex = 0;
                while (currentIndex < buffer.length) {
                    const type = buffer.readUInt8(
                        currentIndex + DOCKER_OUTPUT_HEADER_FRAME_TYPE_INDEX);
                    const size = buffer.readUInt32BE(
                        currentIndex + DOCKER_OUTPUT_HEADER_FRAME_SIZE_INDEX);
                    let payload = buffer.slice(currentIndex + DOCKER_OUTPUT_PAYLOAD_INDEX,
                        currentIndex + DOCKER_OUTPUT_PAYLOAD_INDEX + size);

                    payloads.push({
                        type: type,
                        size: size,
                        payload: payload.toString()
                    });

                    currentIndex += PAYLOAD_HEADER_SIZE + size;
                }

                if (currentIndex !== buffer.length) {
                    logger.warn('Docker buffer not entirely read', buffer);
                }

                return payloads;
            })
            .flatten()
            .filter()
            .value();
    }
}

module.exports = HigherDockerManager;
import _ from 'lodash';
import { EventEmitter } from 'events';

const statusEmitter = new EventEmitter();
statusEmitter.setMaxListeners(20);

const trackedStatus = {
  restartStatus: {},
};

const debouncedEmit = _.debounce(() => {
  statusEmitter.emit("update");
}, 300);

const updateStatus = (path, value) => {
  const currentValue = _.get(trackedStatus, path);
  if (currentValue !== value) {
    _.set(trackedStatus, path, value);
    debouncedEmit();
  }
};

const getStatus = () => _.cloneDeep(trackedStatus);

export { statusEmitter, updateStatus, getStatus };

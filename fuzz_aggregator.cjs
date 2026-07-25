const { FuzzedDataProvider } = require('@jazzer.js/core');
const aggregatorModule = require('./dist/aggregator.cjs');
const Aggregator = aggregatorModule.default || aggregatorModule;
const AggregatorBatchError = aggregatorModule.AggregatorBatchError;

function createFuzzedInput(provider, depth = 0, maxDepth = 3) {
    if (depth >= maxDepth) {
        return provider.consumeString(10);
    }
    const choice = provider.consumeIntegralInRange(0, 5);
    switch (choice) {
        case 0:
            return provider.consumeString(15);
        case 1:
            return provider.consumeNumber();
        case 2:
            return provider.consumeBoolean();
        case 3: {
            const arr = [];
            const len = provider.consumeIntegralInRange(0, 5);
            for (let i = 0; i < len; i++) {
                arr.push(createFuzzedInput(provider, depth + 1, maxDepth));
            }
            return arr;
        }
        case 4: {
            const obj = {};
            const keysCount = provider.consumeIntegralInRange(0, 5);
            for (let i = 0; i < keysCount; i++) {
                const key = provider.consumeString(10);
                obj[key] = createFuzzedInput(provider, depth + 1, maxDepth);
            }
            return obj;
        }
        default:
            return null;
    }
}

module.exports.fuzz = function(data) {
    try {
        const provider = new FuzzedDataProvider(data);
        
        const limit = provider.consumeIntegralInRange(1, 100);
        const delay = provider.consumeIntegralInRange(0, 50);
        const timeout = provider.consumeIntegralInRange(1, 1000);

        const cb = (ids) => {
            const res = {};
            for (const id of ids) {
                res[typeof id === 'object' ? JSON.stringify(id) : id] = provider.consumeString(10);
            }
            return res;
        };

        const aggregator = new Aggregator(cb, {
            limit,
            delay,
            timeout,
            normalizeID: (id) => (typeof id === 'object' ? JSON.stringify(id) : id)
        });

        const idCount = provider.consumeIntegralInRange(1, 5);
        const ids = [];
        for (let i = 0; i < idCount; i++) {
            ids.push(createFuzzedInput(provider));
        }

        const singleId = createFuzzedInput(provider);
        const extraArg = createFuzzedInput(provider);

        aggregator.execute(singleId, extraArg).catch(() => {});
        aggregator.execute(ids, extraArg).catch(() => {});

        if (provider.consumeBoolean()) {
            aggregator.pause();
        }
        if (provider.consumeBoolean()) {
            aggregator.resume();
        }

        if (AggregatorBatchError) {
            const errMap = { key1: new Error('test') };
            const resMap = { key2: 'val' };
            const batchErr = new AggregatorBatchError(errMap, resMap);
            batchErr.toString();
            batchErr.toJSON();
        }
    } catch (e) {
        if (e instanceof RangeError || e instanceof TypeError) {
            return;
        }
        throw e;
    }
};

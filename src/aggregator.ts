import { objectStringify } from '@webergency-utils/object-hash';

const nextTick = typeof process !== 'undefined' && typeof process.nextTick === 'function'
    ? process.nextTick.bind( process )
    : queueMicrotask;

const EMPTY_OBJ: Record<any, any> = Object.create( null );

const setKey = ( target: Record<any, any>, key: any, value: any ) =>
{
    if( key === '__proto__' )
    {
        Object.defineProperty( target, key, { value, enumerable : true, configurable : true, writable : true });
    }
    else { target[key] = value }
};

export class AggregatorBatchError extends Error
{
    errors   : Record<any, Error>;
    resolved : Record<any, any>;

    constructor( errors: Record<any, Error>, resolved: Record<any, any> )
    {
        super( `Batch failed for ${ Object.keys( errors ).length } key(s)` );
        this.name = 'AggregatorBatchError';
        this.errors = errors;
        this.resolved = resolved;
    }

    toString()
    {
        return `AggregatorBatchError: failed keys [ ${ Object.keys( this.errors ).join( ', ' ) } ]`;
    }

    toJSON()
    {
        return { name : 'AggregatorBatchError', keys : Object.keys( this.errors ) };
    }
}

type Call =
    {
        key     : any
        idx     : number
        keys    : any[] | undefined
        resolve : ( result: any ) => void
        reject  : ( err: any ) => void
    };

type Aggregate<ID> =
    {
        id          : string
        ids         : Map<any, number>
        list        : ID[]
        args        : any[]
        calls       : Call[]
        completion? : Promise<void>
        done?       : () => void
    };

export type AggregatorOptions<ID = any> =
    {
        limit?       : number
        delay?       : number
        timeout?     : number
        normalizeID? : ( id: ID ) => any
    };

export type AggregatorCallback<ID, V> = ( ids: ID[], ...args: any[]) => Record<any, V | Error> | ( V | Error )[] | Promise<Record<any, V | Error> | ( V | Error )[]>;

export default class Aggregator<ID, V>
{
    #callback           : AggregatorCallback<ID, V>;
    #aggregates         : Map<string, Aggregate<ID>> = new Map();
    #pending_aggregates : Map<string, Set<Aggregate<ID>>> = new Map();
    #aggregating = false;
    #paused = false;
    #flushId = 0;
    #limit              : number;
    #delay              : number;
    #timeout            : number | undefined;
    #normalizeID        : (( id: ID ) => any ) | undefined;
    #timer              : ReturnType<typeof setTimeout> | undefined;
    #timeoutQueue       : Map<Aggregate<ID>, number> = new Map();
    #timeoutTimer       : ReturnType<typeof setTimeout> | undefined;

    constructor( callback: AggregatorCallback<ID, V>, options?: AggregatorOptions<ID> )
    {
        if( options?.limit !== undefined && ( !( options.limit >= 1 ) || ( !Number.isInteger( options.limit ) && options.limit !== Infinity )))
        {
            throw new RangeError( 'Aggregator limit must be a positive integer or Infinity' );
        }

        if( options?.timeout !== undefined && !( options.timeout >= 0 ))
        {
            throw new RangeError( 'Aggregator timeout must be a non-negative number' );
        }

        this.#callback = callback;
        this.#limit = options?.limit ?? Infinity;
        this.#delay = options?.delay ?? 0;
        this.#timeout = options?.timeout;
        this.#normalizeID = options?.normalizeID;
    }

    pause()
    {
        this.#paused = true;

        if( this.#aggregating )
        {
            if( this.#timer !== undefined )
            {
                clearTimeout( this.#timer );
                this.#timer = undefined;
            }

            this.#aggregating = false;
            this.#flushId++;
        }
    }

    resume()
    {
        this.#paused = false;

        if( this.#aggregates.size > 0 )
        {
            this.#schedule_flush();
        }
    }

    #queue_timeout( aggregate: Aggregate<ID> )
    {
        const deadline = Date.now() + this.#timeout!;

        this.#timeoutQueue.set( aggregate, deadline );

        this.#schedule_timeout();
    }

    #schedule_timeout()
    {
        if( this.#timeoutTimer !== undefined || this.#timeoutQueue.size === 0 ){ return }

        const nextDeadline = this.#timeoutQueue.values().next().value!;
        const delay = Math.max( 0, nextDeadline - Date.now());

        this.#timeoutTimer = setTimeout(() => this.#dispatch_timeouts(), delay );
    }

    #dispatch_timeouts()
    {
        this.#timeoutTimer = undefined;

        const now = Date.now();

        for( const [ aggregate, deadline ] of this.#timeoutQueue )
        {
            if( deadline > now + 4 ){ break }

            this.#reject( aggregate, new Error( `Timeout of ${ this.#timeout }ms exceeded` ));
        }

        this.#schedule_timeout();
    }

    #complete( aggregate: Aggregate<ID> )
    {
        aggregate.calls = [];

        if( this.#timeoutQueue.size > 0 && this.#timeoutQueue.delete( aggregate ) && this.#timeoutQueue.size === 0 && this.#timeoutTimer !== undefined )
        {
            clearTimeout( this.#timeoutTimer );
            this.#timeoutTimer = undefined;
        }

        if( this.#aggregates.get( aggregate.id ) === aggregate )
        {
            this.#aggregates.delete( aggregate.id );

            if( this.#aggregates.size === 0 && this.#aggregating )
            {
                if( this.#timer !== undefined )
                {
                    clearTimeout( this.#timer );
                    this.#timer = undefined;
                }

                this.#aggregating = false;
                this.#flushId++;
            }
        }

        const pending = this.#pending_aggregates.get( aggregate.id );

        if( pending )
        {
            pending.delete( aggregate );

            ( !pending.size ) && this.#pending_aggregates.delete( aggregate.id );
        }

        aggregate.done?.();
    }

    #reject( aggregate: Aggregate<ID>, err: any )
    {
        const calls = aggregate.calls;

        for( let i = 0; i < calls.length; i++ )
        {
            calls[i].reject( err );
        }

        this.#complete( aggregate );
    }

    #resolve( aggregate: Aggregate<ID>, result: any )
    {
        const isArray = Array.isArray( result );
        const calls = aggregate.calls;

        for( let c = 0; c < calls.length; c++ )
        {
            const call = calls[c];
            const keys = call.keys;

            if( keys !== undefined )
            {
                const len = keys.length;
                const values = new Array( len );
                let hasError = false;

                for( let i = 0; i < len; i++ )
                {
                    const key = keys[i];
                    const val = isArray
                        ? result[aggregate.ids.get( key )!]
                        : ( Object.hasOwn( result, key ) ? result[key] : undefined );

                    if( val instanceof Error ){ hasError = true }

                    values[i] = val;
                }

                if( hasError )
                {
                    const errors: Record<any, Error> = {}, resolved: Record<any, any> = {};

                    for( let i = 0; i < len; i++ )
                    {
                        const val = values[i];

                        setKey( val instanceof Error ? errors : resolved, keys[i], val );
                    }

                    call.reject( new AggregatorBatchError( errors, resolved ));
                }
                else { call.resolve( values ) }
            }
            else
            {
                const key = call.key;
                const value = isArray
                    ? result[call.idx]
                    : ( Object.hasOwn( result, key ) ? result[key] : undefined );

                value instanceof Error ? call.reject( value ) : call.resolve( value );
            }
        }

        this.#complete( aggregate );
    }

    #execute_aggregate( aggregate: Aggregate<ID> )
    {
        const ids = aggregate.list;

        if( ids.length <= this.#limit )
        {
            let promise: Promise<any>;

            try
            {
                const res = aggregate.args.length
                    ? this.#callback( ids, ...aggregate.args )
                    : this.#callback( ids );

                promise = res instanceof Promise ? res : Promise.resolve( res );
            }
            catch( err )
            {
                promise = Promise.reject( err );
            }

            promise.then(
                chunkResult => this.#resolve( aggregate, chunkResult && typeof chunkResult === 'object' ? chunkResult : EMPTY_OBJ ),
                err => this.#reject( aggregate, err )
            );

            return;
        }

        const chunks: ID[][] = [];

        for( let i = 0; i < ids.length; i += this.#limit )
        {
            chunks.push( ids.slice( i, i + this.#limit ));
        }

        Promise.all( chunks.map( chunk =>
        {
            try
            {
                const result = this.#callback( chunk, ...aggregate.args );

                return result instanceof Promise ? result : Promise.resolve( result );
            }
            catch( err ){ return Promise.reject( err ) }
        }))
            .then(
                chunkResults =>
                {
                    const combined: Record<any, any> = Object.create( null );
                    let keys: any[] | undefined;

                    for( let i = 0; i < chunks.length; i++ )
                    {
                        const chunkResult = chunkResults[i];

                        if( Array.isArray( chunkResult ))
                        {
                            keys ??= [ ...aggregate.ids.keys() ];

                            const offset = i * this.#limit;
                            const len = chunks[i].length;

                            for( let j = 0; j < len; j++ )
                            {
                                combined[keys[offset + j]] = chunkResult[j];
                            }
                        }
                        else if( chunkResult && typeof chunkResult === 'object' )
                        {
                            Object.assign( combined, chunkResult );
                        }
                    }

                    this.#resolve( aggregate, combined );
                },
                err => this.#reject( aggregate, err )
            );
    }

    #aggregated_calls()
    {
        this.#aggregating = false;
        this.#timer = undefined;
        this.#flushId++;

        const aggregates = [ ...this.#aggregates.values() ];

        this.#aggregates.clear();

        for( let i = 0; i < aggregates.length; i++ )
        {
            const aggregate = aggregates[i];
            let pending = this.#pending_aggregates.get( aggregate.id );

            if( !pending )
            {
                this.#pending_aggregates.set( aggregate.id, pending = new Set());
            }

            pending.add( aggregate );

            this.#execute_aggregate( aggregate );
        }
    }

    #schedule_flush()
    {
        if( this.#paused || this.#aggregating ){ return }

        this.#aggregating = true;

        if( this.#delay > 0 )
        {
            this.#timer = setTimeout(() => this.#aggregated_calls(), this.#delay );
        }
        else
        {
            const flushId = ++this.#flushId;

            nextTick(() =>
            {
                if( this.#flushId === flushId )
                {
                    this.#aggregated_calls();
                }
            });
        }
    }

    #get_or_create_aggregate( aggregateID: string, args: any[])
    {
        let aggregate = this.#aggregates.get( aggregateID );

        if( aggregate === undefined )
        {
            this.#aggregates.set( aggregateID, aggregate = { id : aggregateID, ids : new Map(), list : [], args, calls : [] });

            if( this.#timeout !== undefined )
            {
                this.#queue_timeout( aggregate );
            }
        }

        return aggregate;
    }

    #add_id( aggregate: Aggregate<ID>, key: any, id: ID )
    {
        let idx = aggregate.ids.get( key );

        if( idx === undefined )
        {
            idx = aggregate.list.length;
            aggregate.ids.set( key, idx );
            aggregate.list.push( id );
        }

        return idx;
    }

    execute( id: ID, ...args: any[]): Promise<V>;
    execute( ids: ID[], ...args: any[]): Promise<V[]>;
    execute( ids: ID | ID[], ...args: any[])
    {
        if( Array.isArray( ids ) && !ids.length ){ return Promise.resolve([]) }

        const aggregateID = args.length ? objectStringify( args ) : '';

        return new Promise(( resolve, reject ) =>
        {
            const pending = this.#pending_aggregates.get( aggregateID );

            if( Array.isArray( ids ))
            {
                const normalize = this.#normalizeID;
                let keys: any[];

                if( normalize !== undefined )
                {
                    keys = new Array( ids.length );

                    for( let i = 0; i < ids.length; i++ )
                    {
                        keys[i] = normalize( ids[i]);
                    }
                }
                else { keys = ids }

                if( pending !== undefined )
                {
                    const unique = new Map<any, ID>();
                    const matches: { aggregate : Aggregate<ID>, keys : any[] }[] = [];

                    for( let i = 0; i < ids.length; i++ )
                    {
                        unique.set( keys[i], ids[i]);
                    }

                    for( const aggregate of pending )
                    {
                        const matchedKeys: any[] = [];

                        for( const key of unique.keys())
                        {
                            if( aggregate.ids.has( key ))
                            {
                                unique.delete( key );
                                matchedKeys.push( key );
                            }
                        }

                        if( matchedKeys.length > 0 )
                        {
                            matches.push({ aggregate, keys : matchedKeys });
                        }
                    }

                    if( matches.length > 0 )
                    {
                        const result: Record<any, any> = Object.create( null );
                        const original_resolve = resolve, original_reject = reject, original_keys = keys;
                        let pendingCount = matches.length + ( unique.size > 0 ? 1 : 0 );

                        const done = () =>
                        {
                            if( --pendingCount > 0 ){ return }

                            const len = original_keys.length;
                            const values = new Array( len );
                            let hasError = false;

                            for( let i = 0; i < len; i++ )
                            {
                                const val = result[original_keys[i]];

                                if( val instanceof Error ){ hasError = true }

                                values[i] = val;
                            }

                            if( hasError )
                            {
                                const errors: Record<any, Error> = {}, resolved: Record<any, any> = {};

                                for( let i = 0; i < len; i++ )
                                {
                                    const val = values[i];

                                    setKey( val instanceof Error ? errors : resolved, original_keys[i], val );
                                }

                                original_reject( new AggregatorBatchError( errors, resolved ));
                            }
                            else { original_resolve( values ) }
                        };

                        const recordResolved = ( batchKeys: any[], partialResult: any[]) =>
                        {
                            for( let i = 0; i < batchKeys.length; i++ )
                            {
                                result[batchKeys[i]] = partialResult[i];
                            }

                            done();
                        };

                        const recordRejected = ( batchKeys: any[], err: any ) =>
                        {
                            if( err instanceof AggregatorBatchError )
                            {
                                for( let i = 0; i < batchKeys.length; i++ )
                                {
                                    const key = batchKeys[i];

                                    result[key] = Object.hasOwn( err.errors, key ) ? err.errors[key] : err.resolved[key];
                                }
                            }
                            else
                            {
                                for( let i = 0; i < batchKeys.length; i++ )
                                {
                                    result[batchKeys[i]] = err;
                                }
                            }

                            done();
                        };

                        for( let i = 0; i < matches.length; i++ )
                        {
                            const { aggregate, keys : matchedKeys } = matches[i];

                            aggregate.calls.push(
                                {
                                    key     : undefined,
                                    idx     : -1,
                                    keys    : matchedKeys,
                                    resolve : ( partial_result: any ) => recordResolved( matchedKeys, partial_result ),
                                    reject  : ( err: any ) => recordRejected( matchedKeys, err )
                                });
                        }

                        if( unique.size === 0 )
                        {
                            return;
                        }

                        const remainingKeys = [ ...unique.keys() ];
                        const aggregate = this.#get_or_create_aggregate( aggregateID, args );

                        for( const [ key, id ] of unique )
                        {
                            this.#add_id( aggregate, key, id );
                        }

                        aggregate.calls.push(
                            {
                                key     : undefined,
                                idx     : -1,
                                keys    : remainingKeys,
                                resolve : ( partial_result: any ) => recordResolved( remainingKeys, partial_result ),
                                reject  : ( err: any ) => recordRejected( remainingKeys, err )
                            });

                        this.#schedule_flush();

                        return;
                    }
                }

                const aggregate = this.#get_or_create_aggregate( aggregateID, args );

                for( let i = 0; i < ids.length; i++ )
                {
                    this.#add_id( aggregate, keys[i], ids[i]);
                }

                aggregate.calls.push({ key : undefined, idx : -1, keys, resolve : resolve as ( result: any ) => void, reject });

                this.#schedule_flush();

                return;
            }

            const key = this.#normalizeID !== undefined ? this.#normalizeID( ids ) : ids;

            if( pending !== undefined )
            {
                for( const aggregate of pending )
                {
                    const idx = aggregate.ids.get( key );

                    if( idx !== undefined )
                    {
                        aggregate.calls.push({ key, idx, keys : undefined, resolve, reject });

                        return;
                    }
                }
            }

            const aggregate = this.#get_or_create_aggregate( aggregateID, args );
            const idx = this.#add_id( aggregate, key, ids );

            aggregate.calls.push({ key, idx, keys : undefined, resolve : resolve as ( result: any ) => void, reject });

            this.#schedule_flush();
        });
    }

    async drain()
    {
        while( this.#aggregates.size || this.#pending_aggregates.size )
        {
            if( this.#aggregates.size )
            {
                if( this.#timer !== undefined )
                {
                    clearTimeout( this.#timer );
                }

                this.#aggregated_calls();
            }

            const promises: Promise<void>[] = [];

            for( const set of this.#pending_aggregates.values())
            {
                for( const aggregate of set )
                {
                    promises.push( aggregate.completion ??= new Promise<void>( resolve => { aggregate.done = resolve }));
                }
            }

            await Promise.all( promises );
        }
    }
}

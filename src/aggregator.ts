import { objectStringify } from '@webergency-utils/object-hash';

const nextTick = typeof process !== 'undefined' && typeof process.nextTick === 'function'
    ? ( callback: () => unknown ) => process.nextTick( callback )
    : ( callback: () => unknown ) => queueMicrotask( callback );

const defineKey = ( target: Record<any, any>, key: any, value: any ) =>
{
    Object.defineProperty( target, key, { value, enumerable : true, configurable : true, writable : true });
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

type Aggregate<ID> =
    {
        id          : string
        ids         : Map<any, ID>
        args        : any[]
        calls       : { id : ID | ID[], resolve : ( result: any ) => void, reject : ( err: any ) => void }[]
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

    #normalize( id: ID )
    {
        return this.#normalizeID ? this.#normalizeID( id ) : id;
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

        if( this.#timeoutQueue.delete( aggregate ) && this.#timeoutQueue.size === 0 && this.#timeoutTimer !== undefined )
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
        for( const call of aggregate.calls )
        {
            call.reject( err );
        }

        this.#complete( aggregate );
    }

    #resolve( aggregate: Aggregate<ID>, result: Record<any, any> )
    {
        for( const call of aggregate.calls )
        {
            if( Array.isArray( call.id ))
            {
                const keys = call.id.map( id => this.#normalize( id ) as any );
                const values = keys.map( key => result[key]);

                if( values.some( v => v instanceof Error ))
                {
                    const errors: Record<any, Error> = {}, resolved: Record<any, any> = {};

                    keys.forEach(( key, i ) => defineKey( values[i] instanceof Error ? errors : resolved, key, values[i]));

                    call.reject( new AggregatorBatchError( errors, resolved ));
                }
                else { call.resolve( values ) }
            }
            else
            {
                const value = result[this.#normalize( call.id ) as any];

                value instanceof Error ? call.reject( value ) : call.resolve( value );
            }
        }

        this.#complete( aggregate );
    }

    #execute_aggregate( aggregate: Aggregate<ID> )
    {
        const ids = [ ...aggregate.ids.values() ];
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
            .then( chunkResults =>
            {
                const combined: Record<any, any> = Object.create( null );

                for( let i = 0; i < chunks.length; i++ )
                {
                    const chunkResult = chunkResults[i];

                    if( Array.isArray( chunkResult ))
                    {
                        chunks[i].forEach(( id, j ) => combined[this.#normalize( id ) as any] = chunkResult[j]);
                    }
                    else if( chunkResult && typeof chunkResult === 'object' )
                    {
                        Object.assign( combined, chunkResult );
                    }
                }

                this.#resolve( aggregate, combined );
            })
            .catch( err => this.#reject( aggregate, err ));
    }

    #aggregated_calls()
    {
        this.#aggregating = false;
        this.#timer = undefined;
        this.#flushId++;

        const aggregates = [ ...this.#aggregates.values() ];

        this.#aggregates.clear();

        for( const aggregate of aggregates )
        {
            let pending = this.#pending_aggregates.get( aggregate.id );

            if( !pending )
            {
                this.#pending_aggregates.set( aggregate.id, pending = new Set());
            }

            pending.add( aggregate );

            aggregate.completion = new Promise<void>( resolve => { aggregate.done = resolve });

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

    execute( id: ID, ...args: any[]): Promise<V>;
    execute( ids: ID[], ...args: any[]): Promise<V[]>;
    execute( ids: ID | ID[], ...args: any[])
    {
        if( Array.isArray( ids ) && !ids.length ){ return Promise.resolve([]) }

        return new Promise(( resolve, reject ) =>
        {
            const aggregateID = args.length ? objectStringify( args ) : '', pending = this.#pending_aggregates.get( aggregateID ), pending_results: Promise<void>[] = [];

            if( pending )
            {
                if( Array.isArray( ids ))
                {
                    const unique = new Map<any, ID>(), result: Record<any, any> = Object.create( null );

                    const recordResolved = ( batchIds: ID[], partialResult: any[]) =>
                    {
                        batchIds.forEach(( id, i ) => result[this.#normalize( id ) as any] = partialResult[i]);
                    };

                    const recordRejected = ( batchIds: ID[], err: any ) =>
                    {
                        if( err instanceof AggregatorBatchError )
                        {
                            batchIds.forEach( id =>
                            {
                                const key = this.#normalize( id ) as any;

                                result[key] = Object.prototype.hasOwnProperty.call( err.errors, key ) ? err.errors[key] : err.resolved[key];
                            });
                        }
                        else
                        {
                            batchIds.forEach( id => result[this.#normalize( id ) as any] = err );
                        }
                    };

                    for( const id of ids )
                    {
                        unique.set( this.#normalize( id ), id );
                    }

                    for( const aggregate of pending )
                    {
                        const _ids: ID[] = [];

                        for( const [ serialized, id ] of unique )
                        {
                            if( aggregate.ids.has( serialized ))
                            {
                                unique.delete( serialized );
                                _ids.push( id );
                            }
                        }

                        if( _ids.length )
                        {
                            pending_results.push( new Promise<void>( done =>
                            {
                                aggregate.calls.push(
                                    {
                                        id      : _ids,
                                        resolve : ( partial_result: any ) => { recordResolved( _ids, partial_result ); done() },
                                        reject  : ( err: any ) => { recordRejected( _ids, err ); done() }
                                    });
                            }));
                        }
                    }

                    if( pending_results.length )
                    {
                        const original_resolve = resolve, original_reject = reject, original_ids = ids;

                        ids = [ ...unique.values() ];

                        const settle = async() =>
                        {
                            await Promise.all( pending_results );

                            const keys = original_ids.map( id => this.#normalize( id ) as any );
                            const values = keys.map( key => result[key]);

                            if( values.some( v => v instanceof Error ))
                            {
                                const errors: Record<any, Error> = {}, resolved: Record<any, any> = {};

                                keys.forEach(( key, i ) => defineKey( values[i] instanceof Error ? errors : resolved, key, values[i]));

                                original_reject( new AggregatorBatchError( errors, resolved ));
                            }
                            else { original_resolve( values ) }
                        };

                        if( !unique.size )
                        {
                            settle();

                            return; 
                        }

                        resolve = ( partial_result: any ) => { recordResolved( ids as ID[], partial_result ); settle() };
                        reject = ( err: any ) => { recordRejected( ids as ID[], err ); settle() };
                    }
                }
                else
                {
                    const normalized = this.#normalize( ids );

                    for( const aggregate of pending )
                    {
                        if( aggregate.ids.has( normalized ))
                        {
                            aggregate.calls.push({ id : ids, resolve, reject });

                            return;
                        }
                    }
                }
            }

            let aggregate = this.#aggregates.get( aggregateID );

            if( !aggregate )
            {
                this.#aggregates.set( aggregateID, aggregate = { id : aggregateID, ids : new Map<any, ID>(), args, calls : [] });

                if( this.#timeout !== undefined )
                {
                    this.#queue_timeout( aggregate );
                }
            }

            if( Array.isArray( ids ))
            {
                ids.forEach( id => aggregate!.ids.set( this.#normalize( id ), id ));
            }
            else { aggregate.ids.set( this.#normalize( ids ), ids ) }

            aggregate.calls.push({ id : ids, resolve : resolve as ( result: any ) => void, reject });

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
                    promises.push( aggregate.completion! );
                }
            }

            await Promise.all( promises );
        }
    }
}

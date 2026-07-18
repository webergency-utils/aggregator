import { objectStringify } from '@webergency-utils/object-hash';

const nextTick = typeof process !== 'undefined' && typeof process.nextTick === 'function'
    ? ( callback: () => unknown ) => process.nextTick( callback )
    : ( callback: () => unknown ) => queueMicrotask( callback );

export class AggregatorBatchError extends Error
{
    errors: Record<any, Error>;
    resolved: Record<any, any>;

    constructor( errors: Record<any, Error>, resolved: Record<any, any> )
    {
        super( `Batch failed for ${ Object.keys( errors ).length } key(s)` );
        this.errors = errors;
        this.resolved = resolved;
    }

    toString()
    {
        return `AggregatorBatchError: failed keys [ ${ Object.keys( this.errors ).join( ', ' ) } ]`;
    }

    toJSON()
    {
        return { name: 'AggregatorBatchError', keys: Object.keys( this.errors ) };
    }
}

type Aggregate<ID> =
{
    id          : string
    ids         : Map<any, ID>
    args        : any[]
    calls       : { id: ID | ID[], resolve: ( result: any ) => void, reject: ( err: any ) => void }[]
    completion? : Promise<void>
    done?       : () => void
}

export type AggregatorOptions<ID = any> =
{
    limit?       : number
    delay?       : number
    timeout?     : number
    normalizeID? : ( id: ID ) => any
}

export type AggregatorCallback<ID, V> = ( ids: ID[], ...args: any[] ) => Record<any, V> | V[] | Promise<Record<any, V> | V[]>;

export default class Aggregator<ID, V>
{
    #callback: AggregatorCallback<ID, V>;
    #aggregates: Map<string, Aggregate<ID>> = new Map();
    #pending_aggregates: Map<string, Set<Aggregate<ID>>> = new Map();
    #aggregating = false;
    #paused = false;
    #limit: number;
    #delay: number;
    #timeout: number | undefined;
    #normalizeID: ( ( id: ID ) => any ) | undefined;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #timeoutQueue: { deadline: number, aggregate: Aggregate<ID> }[] = [];
    #timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    constructor( callback: AggregatorCallback<ID, V>, options?: AggregatorOptions<ID> )
    {
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

        this.#timeoutQueue.push( { deadline, aggregate } );

        this.#schedule_timeout();
    }

    #schedule_timeout()
    {
        if( this.#timeoutTimer !== undefined ){ return }

        if( this.#timeoutQueue.length === 0 ){ return }

        const next = this.#timeoutQueue[0];
        const delay = Math.max( 0, next.deadline - Date.now() );

        this.#timeoutTimer = setTimeout( () => this.#dispatch_timeouts(), delay );
    }

    #dispatch_timeouts()
    {
        this.#timeoutTimer = undefined;

        const now = Date.now();

        while( this.#timeoutQueue.length > 0 && this.#timeoutQueue[0].deadline <= now + 4 )
        {
            const { aggregate } = this.#timeoutQueue.shift()!;

            if( aggregate.calls.length > 0 )
            {
                this.#reject( aggregate, new Error( `Timeout of ${ this.#timeout }ms exceeded` ) );
            }
        }

        this.#schedule_timeout();
    }

    #complete( aggregate: Aggregate<ID> )
    {
        aggregate.calls = [];

        if( this.#aggregates.get( aggregate.id ) === aggregate )
        {
            this.#aggregates.delete( aggregate.id );
        }

        let pending = this.#pending_aggregates.get( aggregate.id );

        if( pending )
        {
            pending.delete( aggregate );

            ( !pending.size ) && this.#pending_aggregates.delete( aggregate.id );
        }

        aggregate.done?.();
    }

    #reject( aggregate: Aggregate<ID>, err: any )
    {
        for( let call of aggregate.calls )
        {
            call.reject( err );
        }

        this.#complete( aggregate );
    }

    #resolve( aggregate: Aggregate<ID>, result: Record<any, any> )
    {
        for( let call of aggregate.calls )
        {
            if( Array.isArray( call.id ))
            {
                let values = call.id.map( id => result[this.#normalize( id ) as any] );

                if( values.some( v => v instanceof Error ))
                {
                    let errors: Record<any, Error> = {}, resolved: Record<any, any> = {};

                    call.id.forEach(( id, i ) => values[i] instanceof Error
                        ? errors[this.#normalize( id ) as any] = values[i]
                        : resolved[this.#normalize( id ) as any] = values[i]
                    );

                    call.reject( new AggregatorBatchError( errors, resolved ));
                }
                else{ call.resolve( values ) }
            }
            else
            {
                let value = result[this.#normalize( call.id ) as any];

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
                let result = this.#callback( chunk, ...aggregate.args );

                return result instanceof Promise ? result : Promise.resolve( result );
            }
            catch( err ){ return Promise.reject( err ) }
        }))
        .then( chunkResults =>
        {
            let combined: Record<any, any> = {};

            for( let i = 0; i < chunks.length; i++ )
            {
                let chunkResult = chunkResults[i];

                if( Array.isArray( chunkResult ))
                {
                    chunks[i].forEach(( id, j ) => combined[this.#normalize( id ) as any] = chunkResult[j] );
                }
                else
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

        for( let aggregate of this.#aggregates.values() )
        {
            this.#aggregates.delete( aggregate.id );

            let pending = this.#pending_aggregates.get( aggregate.id );

            if( !pending )
            {
                this.#pending_aggregates.set( aggregate.id, pending = new Set() );
            }

            pending.add( aggregate );

            aggregate.completion = new Promise<void>( resolve => { aggregate.done = resolve });

            this.#execute_aggregate( aggregate );
        }
    }

    #schedule_flush()
    {
        if( this.#paused ){ return }

        if( !this.#aggregating )
        {
            this.#aggregating = true;

            if( this.#delay > 0 )
            {
                this.#timer = setTimeout( () => this.#aggregated_calls(), this.#delay );
            }
            else
            {
                nextTick( this.#aggregated_calls.bind( this ));
            }
        }
    }

    execute( id: ID, ...args: any[] ): Promise<V>;
    execute( ids: ID[], ...args: any[] ): Promise<V[]>;
    execute( ids: ID | ID[], ...args: any[] )
    {
        return new Promise(( resolve, reject ) =>
        {
            let aggregateID = objectStringify( args ), pending, aggregate, pending_results: Promise<void>[] = [];

            if( pending = this.#pending_aggregates.get( aggregateID ))
            {
                if( Array.isArray( ids ))
                {
                    let unique = new Map<any, ID>(), result: Record<any, any> = {};

                    for( let id of ids )
                    {
                        unique.set( this.#normalize( id ), id );
                    }

                    for( let aggregate of pending )
                    {
                        let _ids: ID[] = [];

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
                            pending_results.push( new Promise<void>( resolve =>
                            {
                                aggregate.calls.push({ id: _ids, resolve: ( partial_result: any ) =>
                                {
                                    _ids.forEach(( id, i ) => result[this.#normalize( id ) as any] = partial_result[i] );

                                    resolve();
                                },
                                reject: ( err: any ) =>
                                {
                                    if( err instanceof AggregatorBatchError )
                                    {
                                        _ids.forEach( id => result[this.#normalize( id ) as any] = err.errors[this.#normalize( id ) as any] ?? err );
                                    }
                                    else
                                    {
                                        _ids.forEach( id => result[this.#normalize( id ) as any] = err );
                                    }

                                    resolve();
                                }});
                            }));
                        }
                    }

                    if( pending_results.length )
                    {
                        let original_resolve = resolve, original_ids = ids;

                        ids = [ ...unique.values() ];

                        resolve = async( partial_result: any ) =>
                        {
                            ( ids as ID[] ).forEach(( id: ID, i: number ) => result[this.#normalize( id ) as any] = partial_result[i] );

                            await Promise.all( pending_results );

                            let values = original_ids.map( id => result[this.#normalize( id ) as any] );

                            if( values.some( v => v instanceof Error ))
                            {
                                let errors: Record<any, Error> = {}, resolved: Record<any, any> = {};

                                original_ids.forEach(( id, i ) => values[i] instanceof Error
                                    ? errors[this.#normalize( id ) as any] = values[i]
                                    : resolved[this.#normalize( id ) as any] = values[i]
                                );

                                return reject( new AggregatorBatchError( errors, resolved ));
                            }

                            original_resolve( values );
                        }

                        if( !unique.size ){ return resolve([]) }
                    }
                }
                else
                {
                    for( let aggregate of pending )
                    {
                        if( aggregate.ids.has( this.#normalize( ids )))
                        {
                            return aggregate.calls.push({ id: ids, resolve, reject });
                        }
                    }
                }
            }

            if( !( aggregate = this.#aggregates.get( aggregateID )))
            {
                this.#aggregates.set( aggregateID, aggregate = { id: aggregateID, ids: new Map<any, ID>(), args, calls: [] });

                if( this.#timeout !== undefined )
                {
                    this.#queue_timeout( aggregate );
                }
            }

            if( Array.isArray( ids ))
            {
                ids.forEach( id => aggregate!.ids.set( this.#normalize( id ), id ));
            }
            else{ aggregate.ids.set( this.#normalize( ids ), ids ) }

            aggregate.calls.push({ id: ids, resolve: resolve as ( result: any ) => void, reject });

            this.#schedule_flush();
        })
    }

    async drain()
    {
        while( this.#aggregates.size || this.#pending_aggregates.size )
        {
            if( this.#aggregating )
            {
                if( this.#timer !== undefined )
                {
                    clearTimeout( this.#timer );
                }

                this.#aggregated_calls();
            }

            if( this.#paused && this.#aggregates.size )
            {
                this.#aggregated_calls();
            }

            if( this.#pending_aggregates.size )
            {
                const promises: Promise<void>[] = [];

                for( let set of this.#pending_aggregates.values() )
                {
                    for( let aggregate of set )
                    {
                        aggregate.completion && promises.push( aggregate.completion );
                    }
                }

                if( promises.length )
                {
                    await Promise.all( promises );
                }
            }
        }
    }
}

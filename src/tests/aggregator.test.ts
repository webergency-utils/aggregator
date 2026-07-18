import 
{ 
    describe, it, expect, vi, 
    beforeEach, afterEach, expectTypeOf 
} 
from 'vitest';
import Aggregator, { AggregatorBatchError } from '../aggregator';

const tick = () => new Promise<void>( ( resolve ) => setTimeout( resolve, 0 ) );

describe( 'Aggregator', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should batch single-ID calls in the same tick into one callback', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );
        const p3 = agg.execute( 'c' );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( [ 'a', 'b', 'c' ] );
        expect( r1 ).toBe( 'val_a' );
        expect( r2 ).toBe( 'val_b' );
        expect( r3 ).toBe( 'val_c' );
    } );

    it( 'should deduplicate IDs within a single batch', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: number[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id * 10 } ), {} as Record<number, number> );
        } );

        const agg = new Aggregator<number, number>( callback );

        // Act
        const p1 = agg.execute( 1 );
        const p2 = agg.execute( 1 );
        const p3 = agg.execute( 2 );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( [ 1, 2 ] );
        expect( r1 ).toBe( 10 );
        expect( r2 ).toBe( 10 );
        expect( r3 ).toBe( 20 );
    } );

    it( 'should support array-ID calls and return results in order', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `result_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const result = await agg.execute( [ 'x', 'y', 'z' ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( [ 'x', 'y', 'z' ] );
        expect( result ).toStrictEqual( [ 'result_x', 'result_y', 'result_z' ] );
    } );

    it( 'should batch array-ID and single-ID calls together', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id.toUpperCase() } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( [ 'a', 'b' ] );
        const p2 = agg.execute( 'c' );
        const p3 = agg.execute( 'a' );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toStrictEqual( [ 'A', 'B' ] );
        expect( r2 ).toBe( 'C' );
        expect( r3 ).toBe( 'A' );
    } );

    it( 'should group by args — different args create separate batches', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[], prefix: string ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `${ prefix }_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a', 'group1' );
        const p2 = agg.execute( 'b', 'group1' );
        const p3 = agg.execute( 'a', 'group2' );
        const p4 = agg.execute( 'c', 'group2' );

        const [ r1, r2, r3, r4 ] = await Promise.all( [ p1, p2, p3, p4 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toBe( 'group1_a' );
        expect( r2 ).toBe( 'group1_b' );
        expect( r3 ).toBe( 'group2_a' );
        expect( r4 ).toBe( 'group2_c' );
    } );

    it( 'should handle callback returning an array — maps by ID insertion order', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: number[] ) =>
        {
            return ids.map( id => id * 100 );
        } );

        const agg = new Aggregator<number, number>( callback );

        // Act
        const p1 = agg.execute( 3 );
        const p2 = agg.execute( 7 );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 300 );
        expect( r2 ).toBe( 700 );
    } );

    it( 'should handle async callback', async () =>
    {
        // Arrange
        const callback = vi.fn( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 10 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `async_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'async_a' );
        expect( r2 ).toBe( 'async_b' );
    } );

    it( 'should reject all calls when sync callback throws', async () =>
    {
        // Arrange
        const err = new Error( 'sync boom' );
        const callback = vi.fn( () => { throw err } );

        const agg = new Aggregator<string, any>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        // Assert
        await expect( p1 ).rejects.toBe( err );
        await expect( p2 ).rejects.toBe( err );
    } );

    it( 'should reject all calls when async callback rejects', async () =>
    {
        // Arrange
        const err = new Error( 'async boom' );
        const callback = vi.fn( async () => { throw err } );

        const agg = new Aggregator<string, any>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        // Assert
        await expect( p1 ).rejects.toBe( err );
        await expect( p2 ).rejects.toBe( err );
    } );

    it( 'should issue separate batches for separate ticks', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `v_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const r1 = await agg.execute( 'a' );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toBe( 'v_a' );

        // Act
        const r2 = await agg.execute( 'b' );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r2 ).toBe( 'v_b' );
    } );

    it( 'should piggyback single-ID call on pending aggregate with same ID', async () =>
    {
        // Arrange
        let resolveCallback!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            return new Promise( ( resolve ) => { resolveCallback = resolve } );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // First tick — creates pending aggregate
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // Second tick — 'a' is still pending, should piggyback
        const p3 = agg.execute( 'a' );

        // Resolve the first callback
        resolveCallback( { a: 'val_a', b: 'val_b' } );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toBe( 'val_a' );
        expect( r2 ).toBe( 'val_b' );
        expect( r3 ).toBe( 'val_a' );
    } );

    it( 'should piggyback array-ID call on pending aggregate — all IDs pending', async () =>
    {
        // Arrange
        let resolveCallback!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            return new Promise( ( resolve ) => { resolveCallback = resolve } );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( [ 'a', 'b', 'c' ] );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // All of [a, b] are pending
        const p2 = agg.execute( [ 'a', 'b' ] );

        resolveCallback( { a: 'A', b: 'B', c: 'C' } );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toStrictEqual( [ 'A', 'B', 'C' ] );
        expect( r2 ).toStrictEqual( [ 'A', 'B' ] );
    } );

    it( 'should split array-ID call — some IDs pending, some new', async () =>
    {
        // Arrange
        let resolveFirst!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            if( callback.mock.calls.length === 1 )
            {
                return new Promise( ( resolve ) => { resolveFirst = resolve } );
            }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `new_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // First batch: a, b
        const p1 = agg.execute( [ 'a', 'b' ] );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // Second tick: [a, c] — 'a' is pending, 'c' is new
        const p2 = agg.execute( [ 'a', 'c' ] );

        // Resolve first batch
        resolveFirst( { a: 'A', b: 'B' } );

        await tick();

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toStrictEqual( [ 'A', 'B' ] );
        expect( r2 ).toStrictEqual( [ 'A', 'new_c' ] );
    } );

    it( 'should handle callback returning object directly', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return { a: 'alpha', b: 'beta', c: 'gamma' };
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'alpha' );
        expect( r2 ).toBe( 'beta' );
    } );

    it( 'should handle complex arg serialization for grouping', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[], opts: { deep: boolean } ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: opts.deep ? 'deep' : 'shallow' } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a', { deep: true } );
        const p2 = agg.execute( 'b', { deep: true } );
        const p3 = agg.execute( 'c', { deep: false } );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toBe( 'deep' );
        expect( r2 ).toBe( 'deep' );
        expect( r3 ).toBe( 'shallow' );
    } );

    it( 'should handle calls with no extra args', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: number[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id + 1 } ), {} as Record<number, number> );
        } );

        const agg = new Aggregator<number, number>( callback );

        // Act
        const result = await agg.execute( 5 );

        // Assert
        expect( callback ).toHaveBeenCalledWith( [ 5 ] );
        expect( result ).toBe( 6 );
    } );

    it( 'should handle a single-element array-ID call', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const result = await agg.execute( [ 'only' ] );

        // Assert
        expect( result ).toStrictEqual( [ 'val_only' ] );
    } );

    it( 'should clean up pending aggregates after resolve', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        await agg.execute( 'a' );
        await agg.execute( 'b' );

        // Assert
        // Both batches resolved; pending should be clean for new batches
        expect( callback ).toHaveBeenCalledTimes( 2 );
    } );

    it( 'should clean up pending aggregates after reject', async () =>
    {
        // Arrange
        let callCount = 0;
        const callback = vi.fn( ( ids: string[] ) =>
        {
            callCount++;

            if( callCount === 1 ){ throw new Error( 'fail' ) }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act & Assert
        await expect( agg.execute( 'a' ) ).rejects.toThrow( 'fail' );

        // Act
        // Second call should work — pending was cleaned up
        const r = await agg.execute( 'a' );

        // Assert
        expect( r ).toBe( 'a' );
    } );

    it( 'should handle many concurrent calls efficiently', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: number[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id * 2 } ), {} as Record<number, number> );
        } );

        const agg = new Aggregator<number, number>( callback );
        const promises = [];

        // Act
        for( let i = 0; i < 100; i++ )
        {
            promises.push( agg.execute( i ) );
        }

        const results = await Promise.all( promises );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        for( let i = 0; i < 100; i++ )
        {
            expect( results[i] ).toBe( i * 2 );
        }
    } );
} );

describe( 'Aggregator — limit', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should split large batches into chunks of limit', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: number[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id * 10 } ), {} as Record<number, number> );
        } );

        const agg = new Aggregator<number, number>( callback, { limit: 2 } );
        const promises = [];

        // Act
        for( let i = 1; i <= 5; i++ )
        {
            promises.push( agg.execute( i ) );
        }

        const results = await Promise.all( promises );

        // Assert
        // 5 IDs / limit 2 = 3 callback invocations (2 + 2 + 1)
        expect( callback ).toHaveBeenCalledTimes( 3 );
        expect( callback.mock.calls[0][0] ).toHaveLength( 2 );
        expect( callback.mock.calls[1][0] ).toHaveLength( 2 );
        expect( callback.mock.calls[2][0] ).toHaveLength( 1 );

        for( let i = 0; i < 5; i++ )
        {
            expect( results[i] ).toBe( ( i + 1 ) * 10 );
        }
    } );

    it( 'should correctly merge array results across chunks', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: number[] ) =>
        {
            return ids.map( id => id * 100 );
        } );

        const agg = new Aggregator<number, number>( callback, { limit: 2 } );

        // Act
        const p1 = agg.execute( 1 );
        const p2 = agg.execute( 2 );
        const p3 = agg.execute( 3 );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toBe( 100 );
        expect( r2 ).toBe( 200 );
        expect( r3 ).toBe( 300 );
    } );

    it( 'should correctly resolve array-ID calls across chunks', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `v_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { limit: 2 } );

        // Act
        const result = await agg.execute( [ 'a', 'b', 'c', 'd', 'e' ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 3 );
        expect( result ).toStrictEqual( [ 'v_a', 'v_b', 'v_c', 'v_d', 'v_e' ] );
    } );

    it( 'should not split when batch size is within limit', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: number[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<number, number> );
        } );

        const agg = new Aggregator<number, number>( callback, { limit: 10 } );
        const promises = [];

        // Act
        for( let i = 0; i < 5; i++ )
        {
            promises.push( agg.execute( i ) );
        }

        await Promise.all( promises );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback.mock.calls[0][0] ).toHaveLength( 5 );
    } );

    it( 'should reject all calls if any chunk throws', async () =>
    {
        // Arrange
        let callNum = 0;

        const callback = vi.fn( ( ids: number[] ) =>
        {
            callNum++;

            if( callNum === 2 ){ throw new Error( 'chunk fail' ) }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<number, number> );
        } );

        const agg = new Aggregator<number, number>( callback, { limit: 2 } );

        // Act
        const p1 = agg.execute( 1 );
        const p2 = agg.execute( 2 );
        const p3 = agg.execute( 3 );
        const p4 = agg.execute( 4 );

        // Assert
        await expect( p1 ).rejects.toThrow( 'chunk fail' );
        await expect( p2 ).rejects.toThrow( 'chunk fail' );
        await expect( p3 ).rejects.toThrow( 'chunk fail' );
        await expect( p4 ).rejects.toThrow( 'chunk fail' );
    } );

    it( 'should work with async callbacks across chunks', async () =>
    {
        // Arrange
        const callback = vi.fn( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 5 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `async_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { limit: 2 } );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );
        const p3 = agg.execute( 'c' );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toBe( 'async_a' );
        expect( r2 ).toBe( 'async_b' );
        expect( r3 ).toBe( 'async_c' );
    } );
} );

describe( 'Aggregator — delay', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should accumulate calls within the delay window into one batch', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { delay: 50 } );

        // Act
        const p1 = agg.execute( 'a' );

        // Wait 20ms — still within delay window
        await new Promise( ( r ) => setTimeout( r, 20 ) );

        const p2 = agg.execute( 'b' );

        // Assert
        // Callback should not have been called yet
        expect( callback ).toHaveBeenCalledTimes( 0 );

        // Act
        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( [ 'a', 'b' ] );
        expect( r1 ).toBe( 'a' );
        expect( r2 ).toBe( 'b' );
    } );

    it( 'should create separate batches when calls are outside the delay window', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `v_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { delay: 30 } );

        // Act
        const r1 = await agg.execute( 'a' );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toBe( 'v_a' );

        // Act
        const r2 = await agg.execute( 'b' );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r2 ).toBe( 'v_b' );
    } );

    it( 'should use nextTick when delay is 0 (default)', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        // Should batch on nextTick
        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toBe( 'a' );
        expect( r2 ).toBe( 'b' );
    } );

    it( 'should accumulate calls spaced over time but within the long delay window into one batch', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { delay: 300 } );

        // Act
        const p1 = agg.execute( 'a' );

        // Wait 100ms
        await new Promise( ( r ) => setTimeout( r, 100 ) );

        const p2 = agg.execute( 'b' );

        // Wait another 100ms (total 200ms elapsed, still within 300ms)
        await new Promise( ( r ) => setTimeout( r, 100 ) );

        const p3 = agg.execute( 'c' );

        // Assert
        // Callback should not have been called yet
        expect( callback ).toHaveBeenCalledTimes( 0 );

        // Act
        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( [ 'a', 'b', 'c' ] );
        expect( r1 ).toBe( 'a' );
        expect( r2 ).toBe( 'b' );
        expect( r3 ).toBe( 'c' );
    } );
} );

describe( 'Aggregator — drain', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should resolve immediately when nothing is queued or in-flight', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        await agg.drain();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 0 );
    } );

    it( 'should flush queued aggregates and wait for them to complete', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `drained_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        // Drain before nextTick fires — should flush immediately
        await agg.drain();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( [ 'a', 'b' ] );

        // Act
        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'drained_a' );
        expect( r2 ).toBe( 'drained_b' );
    } );

    it( 'should wait for async in-flight aggregates to complete', async () =>
    {
        // Arrange
        const callback = vi.fn( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 50 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `async_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        await agg.drain();

        // After drain, all calls should be resolved
        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'async_a' );
        expect( r2 ).toBe( 'async_b' );
    } );

    it( 'should cancel delay timer and flush immediately', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { delay: 5000 } );

        // Act
        const p1 = agg.execute( 'a' );

        // Assert
        // Without drain, callback wouldn't fire for 5 seconds
        expect( callback ).toHaveBeenCalledTimes( 0 );

        // Act
        await agg.drain();

        // Assert
        // Drain should have flushed immediately despite the long delay
        expect( callback ).toHaveBeenCalledTimes( 1 );

        const r1 = await p1;

        expect( r1 ).toBe( 'a' );
    } );

    it( 'should continue accepting new calls after drain', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `v_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        agg.execute( 'a' );

        await agg.drain();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // New call after drain should work normally
        const r = await agg.execute( 'b' );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r ).toBe( 'v_b' );
    } );

    it( 'should handle drain with in-flight rejections', async () =>
    {
        // Arrange
        const callback = vi.fn( async () =>
        {
            await new Promise( ( r ) => setTimeout( r, 10 ) );

            throw new Error( 'boom' );
        } );

        const agg = new Aggregator<string, any>( callback );

        // Act
        const p1 = agg.execute( 'a' );

        // Drain should complete even if in-flight rejects
        await agg.drain();

        // Assert
        await expect( p1 ).rejects.toThrow( 'boom' );
    } );

    it( 'should wait for work added during draining', async () =>
    {
        // Arrange
        let triggered = false;
        const resolved: string[] = [];

        const agg = new Aggregator<string, string>( ( ids: string[] ) =>
        {
            const r = ids.reduce( ( r, id ) => ( { ...r, [id]: `v_${ id }` } ), {} as Record<string, string> );

            // First batch triggers a new call while drain is waiting
            if( !triggered )
            {
                triggered = true;
                agg.execute( 'c' ).then( v => resolved.push( v as string ) );
            }

            return r;
        } );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        await agg.drain();

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        // drain() should have waited for the recursively-added 'c' call too
        expect( r1 ).toBe( 'v_a' );
        expect( r2 ).toBe( 'v_b' );
        expect( resolved ).toStrictEqual( [ 'v_c' ] );
    } );

    it( 'should drain when only in-flight exists (no queued aggregates)', async () =>
    {
        // Arrange
        const callback = vi.fn( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 30 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );

        // Let nextTick fire so the aggregate moves to in-flight
        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // Now drain — aggregating is false, but in_flight has entries
        await agg.drain();

        const r1 = await p1;

        // Assert
        expect( r1 ).toBe( 'a' );
    } );

    it( 'should drain immediately when sync callbacks already resolved', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // Call and let it flush synchronously via drain
        agg.execute( 'a' );

        // drain flushes queued → sync callback resolves immediately → in_flight already empty on next loop check
        await agg.drain();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
    } );
} );

describe( 'Aggregator — pending dedup edge cases', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should fall through when single-ID is not found in any pending aggregate', async () =>
    {
        // Arrange
        let resolveFirst!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            if( callback.mock.calls.length === 1 )
            {
                return new Promise( ( resolve ) => { resolveFirst = resolve } );
            }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `new_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // First batch: a, b — goes pending
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // Second tick: 'c' is NOT in any pending aggregate — should fall through and create new batch
        const p3 = agg.execute( 'c' );

        resolveFirst( { a: 'A', b: 'B' } );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toBe( 'A' );
        expect( r2 ).toBe( 'B' );
        expect( r3 ).toBe( 'new_c' );
    } );

    it( 'should reuse existing pending_aggregates set for same args group', async () =>
    {
        // Arrange
        const resolvers: ( ( v: any ) => void )[] = [];

        const callback = vi.fn( ( ids: string[] ) =>
        {
            return new Promise( ( resolve ) => { resolvers.push( resolve ) } );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // First batch → goes pending
        const p1 = agg.execute( 'a' );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // Second batch (same args group) → pending_aggregates set already exists
        const p2 = agg.execute( 'b' );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );

        // Act
        // Resolve both
        resolvers[0]( { a: 'A' } );
        resolvers[1]( { b: 'B' } );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'A' );
        expect( r2 ).toBe( 'B' );
    } );

    it( 'should handle array-ID call where ALL IDs are already pending', async () =>
    {
        // Arrange
        let resolveFirst!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            if( callback.mock.calls.length === 1 )
            {
                return new Promise( ( resolve ) => { resolveFirst = resolve } );
            }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `new_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // First batch: a, b, c
        const p1 = agg.execute( [ 'a', 'b', 'c' ] );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );

        // Act
        // Second call: [b, c] — ALL IDs are pending, unique becomes empty → return resolve([]) path
        const p2 = agg.execute( [ 'b', 'c' ] );

        resolveFirst( { a: 'A', b: 'B', c: 'C' } );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        // No second callback invocation — all piggybacked
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toStrictEqual( [ 'A', 'B', 'C' ] );
        expect( r2 ).toStrictEqual( [ 'B', 'C' ] );
    } );

    it( 'should handle array-ID pending dedup where some IDs match but new IDs also exist', async () =>
    {
        // Arrange
        let resolveFirst!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            if( callback.mock.calls.length === 1 )
            {
                return new Promise( ( resolve ) => { resolveFirst = resolve } );
            }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `batch2_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // First batch: a, b
        const p1 = agg.execute( [ 'a', 'b' ] );

        await tick();

        // Act
        // Second call: [a, b, c, d] — a,b are pending, c,d are new
        const p2 = agg.execute( [ 'a', 'b', 'c', 'd' ] );

        resolveFirst( { a: 'A', b: 'B' } );

        await tick();

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toStrictEqual( [ 'A', 'B' ] );
        // a,b from pending, c,d from new batch
        expect( r2 ).toStrictEqual( [ 'A', 'B', 'batch2_c', 'batch2_d' ] );
    } );

    it( 'should skip pending aggregates that have no matching IDs in array call', async () =>
    {
        // Arrange
        const resolvers: ( ( v: any ) => void )[] = [];

        const callback = vi.fn( ( ids: string[] ) =>
        {
            return new Promise( ( resolve ) => { resolvers.push( resolve ) } );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // First batch: a, b
        const p1 = agg.execute( [ 'a', 'b' ] );

        await tick();

        // Second batch: c (different IDs) — goes to separate pending aggregate
        const p2 = agg.execute( 'c' );

        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );

        // Act
        // Now call [d, e] — neither matches first pending (a,b) nor second pending (c)
        // The loop iterates both pending aggregates with _ids.length === 0 each time
        const p3 = agg.execute( [ 'd', 'e' ] );

        // Resolve first two batches
        resolvers[0]( { a: 'A', b: 'B' } );
        resolvers[1]( { c: 'C' } );

        await tick();

        // Assert
        // Third batch flushed on nextTick — resolve it too
        expect( callback ).toHaveBeenCalledTimes( 3 );
        resolvers[2]( { d: 'D', e: 'E' } );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( r1 ).toStrictEqual( [ 'A', 'B' ] );
        expect( r2 ).toBe( 'C' );
        expect( r3 ).toStrictEqual( [ 'D', 'E' ] );
    } );

    it( 'should handle drain loop where sync flush leaves in_flight empty', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        // Queue two calls to different arg groups — creates two aggregates
        const p1 = agg.execute( 'a', 'group1' );
        const p2 = agg.execute( 'b', 'group2' );

        // drain flushes both sync → both resolve immediately → in_flight empties within the while loop
        await agg.drain();

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 2 );
        expect( r1 ).toBe( 'a' );
        expect( r2 ).toBe( 'b' );
    } );
} );

describe( 'Aggregator — per-key error isolation', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should reject single-ID call when result value is an Error', async () =>
    {
        // Arrange
        const err = new Error( 'not found' );

        const agg = new Aggregator<string, any>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id === 'bad' ? err : `val_${ id }` } ), {} as Record<string, any> );
        } );

        // Act
        const p1 = agg.execute( 'bad' );
        const p2 = agg.execute( 'good' );

        // Assert
        await expect( p1 ).rejects.toBe( err );

        const r2 = await p2;

        expect( r2 ).toBe( 'val_good' );
    } );

    it( 'should resolve single-ID call when result is not an Error', async () =>
    {
        // Arrange
        const agg = new Aggregator<string, any>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `ok_${ id }` } ), {} as Record<string, any> );
        } );

        // Act
        const result = await agg.execute( 'a' );

        // Assert
        expect( result ).toBe( 'ok_a' );
    } );

    it( 'should reject array-ID call with AggregatorBatchError containing errors and resolved', async () =>
    {
        // Arrange
        const err = new Error( 'bad key' );

        const agg = new Aggregator<string, any>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id === 'b' ? err : `val_${ id }` } ), {} as Record<string, any> );
        } );

        // Act
        const p = agg.execute( [ 'a', 'b', 'c' ] );

        // Assert
        await expect( p ).rejects.toBeInstanceOf( AggregatorBatchError );

        try
        {
            await p;
        }
        catch( e: any )
        {
            expect( e.errors ).toStrictEqual( { b: err } );
            expect( e.resolved ).toStrictEqual( { a: 'val_a', c: 'val_c' } );

            // toString only reveals failing keys — not resolved data
            expect( e.toString() ).toBe( 'AggregatorBatchError: failed keys [ b ]' );

            // toJSON only reveals failing keys — not resolved data
            expect( JSON.stringify( e ) ).toBe( '{"name":"AggregatorBatchError","keys":["b"]}' );
        }
    } );

    it( 'should reject single-ID call with the raw Error — not AggregatorBatchError', async () =>
    {
        // Arrange
        const err = new Error( 'raw' );

        const agg = new Aggregator<string, any>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id === 'x' ? err : `ok_${ id }` } ), {} as Record<string, any> );
        } );

        // Act
        const p = agg.execute( 'x' );

        // Assert
        await expect( p ).rejects.toBe( err );
        await expect( p ).rejects.not.toBeInstanceOf( AggregatorBatchError );
    } );

    it( 'should resolve array-ID call when no values are Errors', async () =>
    {
        // Arrange
        const agg = new Aggregator<string, any>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, any> );
        } );

        // Act
        const result = await agg.execute( [ 'a', 'b' ] );

        // Assert
        expect( result ).toStrictEqual( [ 'val_a', 'val_b' ] );
    } );

    it( 'should isolate errors — only affected callers reject', async () =>
    {
        // Arrange
        const err = new Error( 'fail' );

        const agg = new Aggregator<string, any>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id === 'x' ? err : id.toUpperCase() } ), {} as Record<string, any> );
        } );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'x' );
        const p3 = agg.execute( 'b' );

        const [ r1, r3 ] = await Promise.all( [ p1, p3 ] );

        // Assert
        expect( r1 ).toBe( 'A' );
        expect( r3 ).toBe( 'B' );
        await expect( p2 ).rejects.toBe( err );
    } );

    it( 'should handle errors in chunked batches with limit', async () =>
    {
        // Arrange
        const err = new Error( 'chunk error' );

        const agg = new Aggregator<number, Record<number, any>>( ( ids: number[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id === 3 ? err : id * 10 } ), {} as Record<number, any> );
        }, { limit: 2 } );

        // Act
        const p1 = agg.execute( 1 );
        const p2 = agg.execute( 2 );
        const p3 = agg.execute( 3 );
        const p4 = agg.execute( 4 );

        const [ r1, r2, r4 ] = await Promise.all( [ p1, p2, p4 ] );

        // Assert
        expect( r1 ).toBe( 10 );
        expect( r2 ).toBe( 20 );
        expect( r4 ).toBe( 40 );
        await expect( p3 ).rejects.toBe( err );
    } );

    it( 'should handle errors with async callback', async () =>
    {
        // Arrange
        const err = new Error( 'async fail' );

        const agg = new Aggregator<string, any>( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 10 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: id === 'fail' ? err : `ok_${ id }` } ), {} as Record<string, any> );
        } );

        // Act
        const p1 = agg.execute( 'ok' );
        const p2 = agg.execute( 'fail' );

        const r1 = await p1;

        // Assert
        expect( r1 ).toBe( 'ok_ok' );
        await expect( p2 ).rejects.toBe( err );
    } );

    it( 'should reject piggybacked single-ID call when pending result is an Error', async () =>
    {
        // Arrange
        let resolveFirst!: ( v: any ) => void;
        const err = new Error( 'pending fail' );

        const callback = vi.fn( ( ids: string[] ) =>
        {
            return new Promise( ( resolve ) => { resolveFirst = resolve } );
        } );

        const agg = new Aggregator<string, any>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        await tick();

        // Piggyback on pending 'a'
        const p3 = agg.execute( 'a' );

        resolveFirst( { a: err, b: 'B' } );

        // Assert
        await expect( p1 ).rejects.toBe( err );
        await expect( p3 ).rejects.toBe( err );

        const r2 = await p2;

        expect( r2 ).toBe( 'B' );
    } );

    it( 'should reject split array-ID call with AggregatorBatchError when piggybacked IDs have errors', async () =>
    {
        // Arrange
        let resolveFirst!: ( v: any ) => void;
        const err = new Error( 'piggybacked fail' );

        const callback = vi.fn( ( ids: string[] ) =>
        {
            if( callback.mock.calls.length === 1 )
            {
                return new Promise( ( resolve ) => { resolveFirst = resolve } );
            }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `new_${ id }` } ), {} as Record<string, any> );
        } );

        const agg = new Aggregator<string, any>( callback );

        // Act
        // First batch: a, b
        const p1 = agg.execute( [ 'a', 'b' ] );

        // Attach handler immediately to prevent unhandled rejection
        const p1Check = p1.catch( e => e );

        await tick();

        // Second call: [a, c] — 'a' piggybacks, 'c' is new
        const p2 = agg.execute( [ 'a', 'c' ] );

        // Attach handler before resolving
        const p2Check = p2.catch( e => e );

        // Resolve first batch with error for 'a'
        resolveFirst( { a: err, b: 'B' } );

        const [ e1, e2 ] = await Promise.all( [ p1Check, p2Check ] );

        // Assert
        expect( e1 ).toBeInstanceOf( AggregatorBatchError );
        expect( e1.errors ).toStrictEqual( { a: err } );
        expect( e1.resolved ).toStrictEqual( { b: 'B' } );

        expect( e2 ).toBeInstanceOf( AggregatorBatchError );
        expect( e2.errors ).toStrictEqual( { a: err } );
        expect( e2.resolved ).toStrictEqual( { c: 'new_c' } );
    } );

    it( 'should handle callback returning array with Error instances', async () =>
    {
        // Arrange
        const err = new Error( 'array error' );

        const agg = new Aggregator<number, any[]>( ( ids: number[] ) =>
        {
            return ids.map( id => id === 2 ? err : id * 10 );
        } );

        // Act
        const p1 = agg.execute( 1 );
        const p2 = agg.execute( 2 );
        const p3 = agg.execute( 3 );

        const [ r1, r3 ] = await Promise.all( [ p1, p3 ] );

        // Assert
        expect( r1 ).toBe( 10 );
        expect( r3 ).toBe( 30 );
        await expect( p2 ).rejects.toBe( err );
    } );

    it( 'should handle piggybacked array call when pending batch fully rejects', async () =>
    {
        // Arrange
        let rejectFirst!: ( err: any ) => void;
        const err = new Error( 'full reject' );

        const callback = vi.fn( ( ids: string[] ) =>
        {
            if( callback.mock.calls.length === 1 )
            {
                return new Promise( ( _, reject ) => { rejectFirst = reject } );
            }

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `new_${ id }` } ), {} as Record<string, any> );
        } );

        const agg = new Aggregator<string, any>( callback );

        // Act
        // First batch: a, b
        const p1 = agg.execute( [ 'a', 'b' ] );

        const p1Check = p1.catch( e => e );

        await tick();

        // Second call: [a, c] — 'a' piggybacks, 'c' is new
        const p2 = agg.execute( [ 'a', 'c' ] );

        const p2Check = p2.catch( e => e );

        // Fully reject first batch
        rejectFirst( err );

        const [ e1, e2 ] = await Promise.all( [ p1Check, p2Check ] );

        // Assert
        // p1 gets full rejection (not AggregatorBatchError — entire batch rejected)
        expect( e1 ).toBe( err );

        // p2 gets AggregatorBatchError — piggybacked 'a' has the raw error, 'c' resolved fine
        expect( e2 ).toBeInstanceOf( AggregatorBatchError );
        expect( e2.errors ).toStrictEqual( { a: err } );
        expect( e2.resolved ).toStrictEqual( { c: 'new_c' } );
    } );
} );

describe( 'Aggregator — AsyncLocalStorage context preservation', () =>
{
    const { AsyncLocalStorage } = require( 'async_hooks' );
    const als = new AsyncLocalStorage();

    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should preserve context for each caller after batching', async () =>
    {
        // Arrange
        const agg = new Aggregator<string, string>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id.toUpperCase() } ), {} as Record<string, string> );
        } );

        // Act
        const results = await Promise.all( [
            als.run( 'ctx-A', async () =>
            {
                const result = await agg.execute( 'a' );

                expect( als.getStore() ).toBe( 'ctx-A' );

                return result;
            } ),
            als.run( 'ctx-B', async () =>
            {
                const result = await agg.execute( 'b' );

                expect( als.getStore() ).toBe( 'ctx-B' );

                return result;
            } ),
            als.run( 'ctx-C', async () =>
            {
                const result = await agg.execute( 'c' );

                expect( als.getStore() ).toBe( 'ctx-C' );

                return result;
            } )
        ] );

        // Assert
        expect( results ).toStrictEqual( [ 'A', 'B', 'C' ] );
    } );

    it( 'should preserve context with async callback', async () =>
    {
        // Arrange
        const agg = new Aggregator<string, string>( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 10 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: id.toUpperCase() } ), {} as Record<string, string> );
        } );

        // Act
        const results = await Promise.all( [
            als.run( 'async-A', async () =>
            {
                const result = await agg.execute( 'a' );

                expect( als.getStore() ).toBe( 'async-A' );

                return result;
            } ),
            als.run( 'async-B', async () =>
            {
                const result = await agg.execute( 'b' );

                expect( als.getStore() ).toBe( 'async-B' );

                return result;
            } )
        ] );

        // Assert
        expect( results ).toStrictEqual( [ 'A', 'B' ] );
    } );

    it( 'should preserve context for piggybacked calls', async () =>
    {
        // Arrange
        let resolveCallback!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            return new Promise( ( resolve ) => { resolveCallback = resolve } );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = als.run( 'first', () => agg.execute( 'a' ) );

        await tick();

        // Piggyback — 'a' is already pending
        const p2 = als.run( 'piggyback', () => agg.execute( 'a' ) );

        resolveCallback( { a: 'A' } );

        const [ r1, r2 ] = await Promise.all( [
            als.run( 'first', async () =>
            {
                const result = await p1;

                expect( als.getStore() ).toBe( 'first' );

                return result;
            } ),
            als.run( 'piggyback', async () =>
            {
                const result = await p2;

                expect( als.getStore() ).toBe( 'piggyback' );

                return result;
            } )
        ] );

        // Assert
        expect( r1 ).toBe( 'A' );
        expect( r2 ).toBe( 'A' );
    } );

    it( 'should preserve context for array-ID calls', async () =>
    {
        // Arrange
        const agg = new Aggregator<string, string>( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id.toUpperCase() } ), {} as Record<string, string> );
        } );

        // Act
        const results = await Promise.all( [
            als.run( 'arr-ctx', async () =>
            {
                const result = await agg.execute( [ 'a', 'b' ] );

                expect( als.getStore() ).toBe( 'arr-ctx' );

                return result;
            } ),
            als.run( 'single-ctx', async () =>
            {
                const result = await agg.execute( 'c' );

                expect( als.getStore() ).toBe( 'single-ctx' );

                return result;
            } )
        ] );

        // Assert
        expect( results ).toStrictEqual( [ [ 'A', 'B' ], 'C' ] );
    } );
} );

describe( 'Aggregator — type assertions and edge cases', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should correctly infer return types', () =>
    {
        // Arrange
        const callback = ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, string> );
        };

        const agg = new Aggregator<string, string>( callback );

        // Act & Assert
        expectTypeOf( agg.execute( 'a' ) ).toEqualTypeOf<Promise<string>>();
        expectTypeOf( agg.execute( [ 'a', 'b' ] ) ).toEqualTypeOf<Promise<string[]>>();
    } );

    it( 'should handle empty array of IDs gracefully without triggering callback', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) => ( {} ) );
        const agg = new Aggregator<string, string>( callback );

        // Act
        const result = await agg.execute( [] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 0 );
        expect( result ).toStrictEqual( [] );
    } );

    it( 'should handle callback returning null or undefined', async () =>
    {
        // Arrange
        const callback = vi.fn( () => null as any );
        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( [ 'b', 'c' ] );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBeUndefined();
        expect( r2 ).toStrictEqual( [ undefined, undefined ] );
    } );

    it( 'should handle callback returning object missing some requested keys', async () =>
    {
        // Arrange
        const callback = vi.fn( () => ( { a: 'A' } ) );
        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'A' );
        expect( r2 ).toBeUndefined();
    } );

    it( 'should handle callback returning array with mismatched length', async () =>
    {
        // Arrange
        const callback = vi.fn( () => [ 'first' ] );
        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'first' );
        expect( r2 ).toBeUndefined();
    } );

    it( 'should handle negative delay option by falling back to nextTick', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { delay: -50 } );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toBe( 'a' );
        expect( r2 ).toBe( 'b' );
    } );

    it( 'should handle concurrent drain calls gracefully', async () =>
    {
        // Arrange
        const callback = vi.fn( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 20 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: id } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        const p1 = agg.execute( 'a' );
        const tasks =
        [
            agg.drain(),
            agg.drain(),
            agg.drain()
        ];

        await Promise.all( tasks );

        const r1 = await p1;

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toBe( 'a' );
    } );

    it( 'should handle stress testing with multiple concurrent arg groups and mixed types', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[], group: string ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `${ group }_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );
        const promises: Promise<any>[] = [];

        // Act
        for( let i = 0; i < 50; i++ )
        {
            const group = `group_${ i % 5 }`;

            if( i % 3 === 0 )
            {
                promises.push( agg.execute( [ `id_${ i }`, `id_${ i }_extra` ], group ) );
            }
            else
            {
                promises.push( agg.execute( `id_${ i }`, group ) );
            }
        }

        const results = await Promise.all( promises );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 5 );
        expect( results ).toHaveLength( 50 );
    } );
} );

describe( 'Aggregator — timeout', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should resolve successfully if callback returns before timeout', async () =>
    {
        // Arrange
        const callback = vi.fn( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 20 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `ok_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { timeout: 100 } );

        // Act
        const r1 = await agg.execute( 'a' );

        // Assert
        expect( r1 ).toBe( 'ok_a' );
        expect( callback ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'should reject with timeout error if callback takes longer than timeout', async () =>
    {
        // Arrange
        const callback = vi.fn( async ( ids: string[] ) =>
        {
            await new Promise( ( r ) => setTimeout( r, 150 ) );

            return ids.reduce( ( r, id ) => ( { ...r, [id]: `ok_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { timeout: 50 } );

        // Act
        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        // Assert
        await expect( p1 ).rejects.toThrow( 'Timeout of 50ms exceeded' );
        await expect( p2 ).rejects.toThrow( 'Timeout of 50ms exceeded' );
    } );

    it( 'should prevent double resolution once timeout triggers', async () =>
    {
        // Arrange
        let resolveCallback!: ( v: any ) => void;

        const callback = vi.fn( ( ids: string[] ) =>
        {
            return new Promise( ( resolve ) => { resolveCallback = resolve } );
        } );

        const agg = new Aggregator<string, string>( callback, { timeout: 30 } );

        // Act
        const p1 = agg.execute( 'a' );
        const p1Check = p1.catch( e => e );

        // Wait for timeout to fire
        await new Promise( ( r ) => setTimeout( r, 50 ) );

        // Resolve the callback now (after timeout already fired and rejected)
        resolveCallback( { a: 'ok_a' } );

        // Wait a bit to ensure nothing throws or re-resolves
        await new Promise( ( r ) => setTimeout( r, 20 ) );

        // Assert
        const err = await p1Check;
        expect( err ).toBeInstanceOf( Error );
        expect( err.message ).toBe( 'Timeout of 30ms exceeded' );
    } );
} );

describe( 'Aggregator — ID normalization', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    type ComplexID = { type: string, value: any };

    const normalizeID = ( id: ComplexID ) => `${ id.type }:${ id.value }`;

    it( 'should deduplicate complex IDs using normalizeID', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: ComplexID[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [normalizeID( id )]: `val_${ id.value }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<ComplexID, string>( callback, { normalizeID } );

        // Act
        const p1 = agg.execute( { type: 'user', value: 123 } );
        const p2 = agg.execute( { type: 'user', value: 123 } );
        const p3 = agg.execute( { type: 'user', value: 456 } );

        const [ r1, r2, r3 ] = await Promise.all( [ p1, p2, p3 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback.mock.calls[0][0] ).toHaveLength( 2 );
        expect( r1 ).toBe( 'val_123' );
        expect( r2 ).toBe( 'val_123' );
        expect( r3 ).toBe( 'val_456' );
    } );

    it( 'should map results correctly by normalized ID even when original complex IDs are queried', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: ComplexID[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [normalizeID( id )]: `user_data_${ id.value }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<ComplexID, string>( callback, { normalizeID } );

        // Act
        const p1 = agg.execute( { type: 'user', value: 99 } );
        const p2 = agg.execute( [ { type: 'user', value: 99 }, { type: 'user', value: 100 } ] );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'user_data_99' );
        expect( r2 ).toStrictEqual( [ 'user_data_99', 'user_data_100' ] );
    } );

    it( 'should support mapping to array results with complex ID normalization', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: ComplexID[] ) =>
        {
            return ids.map( id => `array_val_${ id.value }` );
        } );

        const agg = new Aggregator<ComplexID, string>( callback, { normalizeID } );

        // Act
        const p1 = agg.execute( { type: 'item', value: 'apple' } );
        const p2 = agg.execute( { type: 'item', value: 'banana' } );

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( r1 ).toBe( 'array_val_apple' );
        expect( r2 ).toBe( 'array_val_banana' );
    } );
} );

describe( 'Aggregator — pause and resume', () =>
{
    beforeEach( () =>
    {
        vi.clearAllMocks();
    } );

    it( 'should prevent automatic flushes while paused and flush when resumed', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        agg.pause();

        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        // Let nextTick fire
        await tick();

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 0 );

        // Act
        agg.resume();

        // Let nextTick fire for the resumed flush
        await tick();

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( callback ).toHaveBeenCalledWith( [ 'a', 'b' ] );
        expect( r1 ).toBe( 'val_a' );
        expect( r2 ).toBe( 'val_b' );
    } );

    it( 'should still allow drain() to force execution when paused', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback );

        // Act
        agg.pause();

        const p1 = agg.execute( 'a' );
        const p2 = agg.execute( 'b' );

        // Force flush via drain()
        await agg.drain();

        const [ r1, r2 ] = await Promise.all( [ p1, p2 ] );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 1 );
        expect( r1 ).toBe( 'val_a' );
        expect( r2 ).toBe( 'val_b' );
    } );

    it( 'should still trigger query timeouts when paused', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { timeout: 30 } );

        // Act
        agg.pause();

        const p1 = agg.execute( 'a' );
        const p1Check = p1.catch( e => e );

        // Wait for timeout to elapse while paused
        await new Promise( ( r ) => setTimeout( r, 50 ) );

        // Assert
        const err = await p1Check;
        expect( err ).toBeInstanceOf( Error );
        expect( err.message ).toBe( 'Timeout of 30ms exceeded' );
        expect( callback ).toHaveBeenCalledTimes( 0 );
    } );

    it( 'should cancel already scheduled flush when paused', async () =>
    {
        // Arrange
        const callback = vi.fn( ( ids: string[] ) =>
        {
            return ids.reduce( ( r, id ) => ( { ...r, [id]: `val_${ id }` } ), {} as Record<string, string> );
        } );

        const agg = new Aggregator<string, string>( callback, { delay: 50 } );

        // Act
        const p1 = agg.execute( 'a' ); // schedules flush with 50ms delay

        // Pause after it has been scheduled
        agg.pause();

        // Wait 100ms (longer than delay)
        await new Promise( ( r ) => setTimeout( r, 100 ) );

        // Assert
        expect( callback ).toHaveBeenCalledTimes( 0 );
    } );
} );

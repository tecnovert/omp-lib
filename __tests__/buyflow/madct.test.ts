import { jest } from '@jest/globals';
import { CtCoreRpcService } from '../../test/rpc-ct.stub';
import { OpenMarketProtocol } from '../../src/omp';
import { Cryptocurrency, OutputType } from '../../src/interfaces/crypto';
import { BidConfiguration } from '../../src/interfaces/configs';
import { EscrowType, MPAction } from '../../src/interfaces/omp-enums';
import { toSatoshis, strip, log } from '../../src/util';
import { Rpc } from '../../src/abstract/rpc';
import { RpcUnspentOutput } from '../../src/interfaces/rpc';
import delay from 'delay';


jest.setTimeout(600_000);


describe('Buyflow: mad ct', () => {

    const WALLET = '';                      // use the default wallet

    // if its necessary to test for a 2nd wallet, add it in as a test
    // const SECOND_WALLET = 'test-wallet';    // second wallet for the purpose of testing multiwallet

    let buyer: OpenMarketProtocol;
    let seller: OpenMarketProtocol;

    let buyerNode0: CtCoreRpcService;
    let sellerNode1: CtCoreRpcService;
    let otherNode2: CtCoreRpcService;

    beforeAll(async () => {
        buyerNode0 = new CtCoreRpcService();
        buyerNode0.setup('localhost', 19792, 'rpcuser0', 'rpcpass0');

        sellerNode1 = new CtCoreRpcService();
        sellerNode1.setup('localhost', 19793, 'rpcuser1', 'rpcpass1');

        otherNode2= new CtCoreRpcService();
        otherNode2.setup('localhost', 19794, 'rpcuser2', 'rpcpass2');

        buyer = new OpenMarketProtocol({ network: 'testnet'});
        buyer.inject(Cryptocurrency.PART, buyerNode0);

        seller = new OpenMarketProtocol({ network: 'testnet'});
        seller.inject(Cryptocurrency.PART, sellerNode1);

    });

    const ok = JSON.parse(
        `{
        "version": "0.3.0",
        "action": {
            "type": "${MPAction.MPA_LISTING_ADD}",
            "generated": ${+new Date().getTime()},
            "item": {
              "information": {
                "title": "a 6 month old dog",
                "shortDescription": "very cute",
                "longDescription": "not for eating",
                "category": [
                    "Animals"
                ]
              },
              "seller": {
                "address": "pVHUY9AYwNSjbX8f1d4fPgYCkNmZxMC25p",
                "signature": "H7yN04IMrwbUgqFXT5Jzr5BPS5vpNrc9deKaY6jkCh0icM5Z3V5rtle/EkugQccw0vk/K6CReQ8sSSDo5W9Vl1I="
              },
              "payment": {
                "type": "SALE",
                "escrow": {
                  "type": "MAD_CT",
                  "ratio": {
                    "buyer": 100,
                    "seller": 100
                  }
                },
                "options": [
                  {
                    "address": {
                        "type": "STEALTH",
                        "address": "replaced in test"
                    },
                    "currency": "PART",
                    "basePrice": ${toSatoshis(2)},
                    "shippingPrice": {
                        "domestic": ${toSatoshis(0.1)},
                        "international": ${toSatoshis(0.2)}
                    }
                  }
                ]
              },
              "messaging": {
                "options": [
                    {
                      "protocol": "TODO",
                      "publicKey": "TODO"
                    }
                  ]
              }
            }
        }
    }`);

    const config: BidConfiguration = {
        cryptocurrency: Cryptocurrency.PART,
        escrow: EscrowType.MAD_CT,
        shippingAddress: {
            firstName: 'string',
            lastName: 'string',
            addressLine1: 'string',
            city: 'string',
            state: 'string',
            zipCode: 'string',
            country: 'string'
        }
    };

    test('buyflow release', async () => {

        // Step 1: Buyer does bid
        log(' >>>>> Step 1: Buyer does bid');
        const bid = await buyer.bid(WALLET, config, ok);
        const bid_stripped = strip(bid);

        await waitForBlocks(1, buyerNode0);

        // Step 2: seller accepts
        log(' >>>>> Step 2: seller accepts');
        const accept = await seller.accept(WALLET, ok, bid_stripped);
        const accept_stripped = strip(accept);
        await expectCompletedTransaction(accept.action['_rawdesttx'], false);

        await waitForBlocks(1, buyerNode0);

        // Step 3: buyer signs destroy txn (done), signs bid txn (half)
        log(' >>>>> Step 3: buyer signs destroy txn (done), signs bid txn (half)');
        const lock = await buyer.lock(WALLET, ok, bid, accept_stripped);
        const lock_stripped = strip(lock);
        await expectCompletedTransaction(lock.action['_rawdesttx'], false);
        expect(lock.action['_rawreleasetxunsigned']).toEqual(accept.action['_rawreleasetxunsigned']);

        // Step 4: seller signs bid txn (full) and submits
        log(' >>>>> Step 4: seller signs bid txn (full) and submits');
        const complete = await seller.complete(WALLET, ok, bid_stripped, accept_stripped, lock_stripped);

        await waitForBlocks(1, buyerNode0);

        await expectCompletedTransaction(complete, true);

        const completeTxid = await buyerNode0.sendRawTransaction(complete);
        await sellerNode1.sendRawTransaction(complete);
        expect(completeTxid).toBeDefined();

        await waitForBlocks(1, buyerNode0);

        // Step 5: buyer signs release
        log(' >>>>> Step 5: buyer signs release');
        const release = await buyer.release(WALLET, ok, bid, accept);
        await expectCompletedTransaction(release, true);

        const releaseTxid = await buyerNode0.sendRawTransaction(release);
        await sellerNode1.sendRawTransaction(release);
        expect(releaseTxid).toBeDefined();
        log('releaseTxid: ' + releaseTxid);

        await waitForBlocks(1, buyerNode0);

        await expectUtxoWithAmount(releaseTxid, buyerNode0, 2);
        await expectUtxoWithAmount(releaseTxid, sellerNode1, 3.99995000);

        log('!!! buyflow release success!');

    });

    test('buyflow refund', async () => {

        // Step1: Buyer does bid
        log(' >>>>> Step 1: Buyer does bid');
        const bid = await buyer.bid(WALLET, config, ok);
        const bid_stripped = strip(bid);

        await waitForBlocks(1, buyerNode0);

        // Step 2: seller accepts
        log(' >>>>> Step 2: seller accepts');
        const accept = await seller.accept(WALLET, ok, bid_stripped);
        const accept_stripped = strip(accept);
        await expectCompletedTransaction(accept.action['_rawdesttx'], false);

        await waitForBlocks(1, buyerNode0);

        // Step 3: buyer signs destroy txn (done), signs bid txn (half)
        log(' >>>>> Step 3: buyer signs destroy txn (done), signs bid txn (half)');
        const lock = await buyer.lock(WALLET, ok, bid, accept_stripped);
        const lock_stripped = strip(lock);
        await expectCompletedTransaction(lock.action['_rawdesttx'], false);
        expect(lock.action['_rawreleasetxunsigned']).toEqual(accept.action['_rawreleasetxunsigned']);

        // Step 4: seller signs bid txn (full) and submits
        log(' >>>>> Step 4: seller signs bid txn (full) and submits');
        const complete = await seller.complete(WALLET, ok, bid_stripped, accept_stripped, lock_stripped);

        await waitForBlocks(1, buyerNode0);

        await expectCompletedTransaction(complete, true);

        const completeTxid = await buyerNode0.sendRawTransaction(complete);
        await sellerNode1.sendRawTransaction(complete);
        expect(completeTxid).toBeDefined();

        await waitForBlocks(1, buyerNode0);

        // Step 5: seller signs refund
        log(' >>>>> Step 5: seller signs refund');
        const refund = await seller.refund(WALLET, ok, bid, accept, lock);
        await expectCompletedTransaction(refund, true);

        const refundTxid = await buyerNode0.sendRawTransaction(refund);
        await sellerNode1.sendRawTransaction(refund);
        expect(refundTxid).toBeDefined();
        log('refundTxid: ' + refundTxid);

        await waitForBlocks(1, buyerNode0);

        await expectUtxoWithAmount(refundTxid, buyerNode0, 4);
        await expectUtxoWithAmount(refundTxid, sellerNode1, 1.99995000);

        log('!!! buyflow refund success!');

    });

    test('buyflow destroy (& prevent early mining)', async () => {

        // Step 1: Buyer does bid
        log(' >>>>> Step 1: Buyer does bid');
        const bid = await buyer.bid(WALLET, config, ok);
        const bid_stripped = strip(bid);

        await waitForBlocks(1, buyerNode0);

        // Step 2: seller accepts
        log(' >>>>> Step 2: seller accepts');
        const accept = await seller.accept(WALLET, ok, bid_stripped);
        const accept_stripped = strip(accept);
        await expectCompletedTransaction(accept.action['_rawdesttx'], false);

        await waitForBlocks(1, buyerNode0);

        // Step 3: buyer signs destroy txn (done), signs bid txn (half)
        log(' >>>>> Step 3: buyer signs destroy txn (done), signs bid txn (half)');
        const lock = await buyer.lock(WALLET, ok, bid_stripped, accept_stripped);
        const lock_stripped = strip(lock);

        await expectCompletedTransaction(lock.action['_rawdesttx'], false);

        await waitForBlocks(1, buyerNode0);

        // Step 4: seller signs bid txn (full) and submits
        log(' >>>>> Step 4: seller signs bid txn (full) and submits');
        const complete = await seller.complete(WALLET, ok, bid_stripped, accept_stripped, lock_stripped);

        await waitForBlocks(1, buyerNode0);

        await expectCompletedTransaction(complete, true);

        const completeTxid = await buyerNode0.sendRawTransaction(complete);
        expect(completeTxid).toBeDefined();

        await waitForBlocks(1, buyerNode0);

        // Can not destroy the funds before the timer has been reached
        let shouldFailToDestroy = false;
        await buyerNode0.sendRawTransaction(lock.action['_rawdesttx'])
            .catch(reason => {
                shouldFailToDestroy = true;
            });
        expect(shouldFailToDestroy).toEqual(true);

        // Use daemon as a source of truth for what the current time is.
        const now = await buyerNode0.getBlockchainInfo().then(value => +value.mediantime);
        const feasibleFrom = (now + 3000);

        await Promise.all([
            async () => await buyerNode0.call('setmocktime', [feasibleFrom], WALLET),
            async () => await sellerNode1.call('setmocktime', [feasibleFrom], WALLET),
            async () => await otherNode2.call('setmocktime', [feasibleFrom], WALLET),
        ]);

        // Let a few blocks mine
        await waitTillJumped(feasibleFrom, buyerNode0);

        // Should be able to destroy them now
        const destroytxid = await buyerNode0.sendRawTransaction(lock.action['_rawdesttx']);
        expect(destroytxid).toBeDefined();

        log('!!! buyflow destroy success!');

    });

    const expectCompletedTransaction = async (rawtx: any, complete = true) => {
        const verify = await buyerNode0.verifyRawTransaction([rawtx]);
        const completed = verify['complete'];

        if (complete != completed) {
            throw new Error('expected ' + rawtx + ' to be '
                + (complete ? 'completed' : 'incomplete')
                + ', but received ' + completed + ' instead.');
        }
    };

    const expectUtxoWithAmount = async (txid: string, node: Rpc, amount: number) => {
        const outputs: RpcUnspentOutput[] = await node.listUnspent(WALLET, OutputType.BLIND, 0);

        // log(outputs);

        const found = outputs.find(utxo => {
            log('find: ' + utxo.txid + ' === ' + txid + ', ' + utxo.amount + ' === ' + amount);
            return (utxo.txid === txid && utxo.amount === amount);
        });
        if (!found) {
            throw new Error(`expected ${txid} to be found on the node, but didn't find it.`);
        }
    };


    expect.extend({
        async toBeUtxoWithAmount(txid: string, node: Rpc, amount: number): Promise<any> {
            const outputs: RpcUnspentOutput[] = await node.listUnspent(WALLET, OutputType.ANON, 0);

            // log(outputs);

            const found = outputs.find(utxo => {
                log('find: ' + utxo.txid + ' === ' + txid + ', ' + utxo.amount + ' === ' + amount);
                return (utxo.txid === txid && utxo.amount === amount);
            });
            if (found) {
                return {
                    message: () =>
                        `expected ${txid} to be found on the node with amount ${amount}.`,
                    pass: true
                };
            } else {
                return {
                    message: () =>
                        `expected ${txid} to be found on the node but didn't find it.`,
                    pass: false
                };
            }
        }
    });


    const waitTillJumped = async (expectedUnixTime: number, node: Rpc) => {
        return new Promise(async resolve => {
            let wait = true;

            while (wait) {

                const currentTime = await node.getBlockchainInfo().then(value => value.mediantime);
                wait = (currentTime <= expectedUnixTime);
                log(wait ? 'waiting..' : ('finished! ' + currentTime + ' > ' + expectedUnixTime ));
                await delay(1000);
            }

            resolve(null);
        });

    };


    const waitForBlocks = async (blockCount: number, node: Rpc): Promise<void> => {

        const startBlock = await node.getBlockchainInfo().then(value => +value.blocks);
        const targetBlock = startBlock + blockCount;
        log(`waiting for block count: latest block is ${startBlock} (target is ${targetBlock})`);
        let currentBlock = startBlock;

        while (true) {
            await delay(2_000);
            const latestBlock = await node.getBlockchainInfo().then(value => +value.blocks);
            if (latestBlock !== currentBlock) {
                log(`latest block is ${latestBlock} (target is ${targetBlock})`);
                currentBlock = latestBlock;

                if (currentBlock >= targetBlock) {
                    break;
                }
            }
        }
    }

});

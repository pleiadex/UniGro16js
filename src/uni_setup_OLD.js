import * as curves from "./curves.js"
import * as misc from './misc.js'
import * as zkeyUtils from "./uni_zkey_utils.js";
import BigArray from "./bigarray.js";
import chai from "chai";
const assert = chai.assert
import {readR1csHeader} from "r1csfile";
import {
    readBinFile,
    readSection,
    createBinFile,
    writeBigInt,
    readBigInt,
    startWriteSection,
    endWriteSection,
    startReadUniqueSection,
    endReadSection,
    copySection
} from "@iden3/binfileutils";
import { Scalar, F1Field, getCurveFromR} from "ffjavascript";
import fs from "fs"
import * as fastFile from "fastfile"
import { O_TRUNC, O_CREAT, O_RDWR, O_RDONLY} from "constants";
import * as timer from "./timer.js"



export default async function uni_Setup(paramName, RSName, entropy) {
    const startTime = timer.start();
    let partTime;
    
    const TESTFLAG = false;
    console.log(`TESTMODE = ${TESTFLAG}`)
    
    const {fd: fdParam, sections: sectionsParam} = await readBinFile(`resource/subcircuits/${paramName}.dat`, "zkey", 2, 1<<25, 1<<23);
    const param = await zkeyUtils.readRSParams(fdParam, sectionsParam);
    const s_D = param.s_D;
    
    const fdRS = await createBinFile('resource/universal_rs/'+RSName+".urs", "zkey", 1, 4+s_D, 1<<22, 1<<24);
    await copySection(fdParam, sectionsParam, fdRS, 1);
    await copySection(fdParam, sectionsParam, fdRS, 2);
    
    await fdParam.close();

    partTime = timer.start();
    const r1cs = new Array();
    const sR1cs = new Array();
    for(var i=0; i<s_D; i++){
        console.log(`Loading R1CSs...${i+1}/${s_D}`)
        let r1csIdx = String(i);
        const {fd: fdR1cs, sections: sectionsR1cs} = await readBinFile('resource/subcircuits/r1cs/subcircuit'+r1csIdx+".r1cs", "r1cs", 1, 1<<22, 1<<24);
        r1cs.push(await readR1csHeader(fdR1cs, sectionsR1cs, false));
        sR1cs.push(await readSection(fdR1cs, sectionsR1cs, 2));
        await fdR1cs.close();
    }
    console.log(`Loading R1CSs...Done`)
    const r1csTime = timer.end(partTime);

    const curve = param.curve;
    // const sG1 = curve.G1.F.n8*2              // unused
    // const sG2 = curve.G2.F.n8*2              // unused
    const buffG1 = curve.G1.oneAffine;
    const buffG2 = curve.G2.oneAffine;
    const Fr = curve.Fr;
    const G1 = curve.G1;
    const G2 = curve.G2;
    const NConstWires = 1;

    const n = param.n;
    const s_max = param.s_max;
    const omega_x = param.omega_x;
    const omega_y = param.omega_y;

    const m = new Array()          // the numbers of wires
    const mPublic = new Array()    // the numbers of public wires (not including constant wire at zero index)
    const mPrivate = new Array()
    const nConstraints = new Array()
    for(var i=0; i<s_D; i++){
        m.push(r1cs[i].nVars);
        nConstraints.push(r1cs[i].nConstraints)
        mPublic.push(r1cs[i].nOutputs + r1cs[i].nPubInputs + r1cs[i].nPrvInputs) 
        mPrivate.push(m[i] - mPublic[i])
    }
    //console.log(Fr.toObject(omega_x))
    //console.log(Fr.toObject(await Fr.exp(omega_x, n)))
       
    // Generate tau
    var num_keys = 6 // the number of keys in tau
    let rng = new Array(num_keys)
    for(var i = 0; i < num_keys; i++) {
        rng[i] = await misc.getRandomRng(entropy + i)
    }    
    const tau = createTauKey(Fr, rng)
    
    // Write the sigma_G section
    ///////////
    await startWriteSection(fdRS, 3);
    let vk1_alpha_u;
    vk1_alpha_u = await G1.timesFr( buffG1, tau.alpha_u );
    let vk1_alpha_v;
    vk1_alpha_v = await G1.timesFr( buffG1, tau.alpha_v );
    let vk1_gamma_a;
    vk1_gamma_a = await G1.timesFr( buffG1, tau.gamma_a );

    await zkeyUtils.writeG1(fdRS, curve, vk1_alpha_u);
    await zkeyUtils.writeG1(fdRS, curve, vk1_alpha_v);
    await zkeyUtils.writeG1(fdRS, curve, vk1_gamma_a);
    let x=tau.x;
    let y=tau.y;
    if (TESTFLAG){
        x = Fr.e(13);
        y = Fr.e(23);
    }

    // if(TESTFLAG){  // UNUSED, since pairingEQ doesnt work for the points of infinity
    //     x=Fr.exp(omega_x, Fr.toObject(tau.x));
    //     y=Fr.exp(omega_y, Fr.toObject(tau.y));
    // }
    
    let vk1_xy_pows = Array.from(Array(n), () => new Array(s_max));
    let xy_pows = Array.from(Array(n), () => new Array(2*s_max-1)); // n by s_max 2d array

    for(var i = 0; i < n; i++) {
        for(var j = 0; j < 2*s_max-1; j++){
            xy_pows[i][j] = await Fr.mul(await Fr.exp(x,i), await Fr.exp(y,j));
        }
    }

    for(var i = 0; i < n; i++) {
        for(var j = 0; j < s_max; j++){
            vk1_xy_pows[i][j] = await G1.timesFr(buffG1, xy_pows[i][j]);
            await zkeyUtils.writeG1(fdRS, curve, vk1_xy_pows[i][j]);
            // [x^0*y^0], [x^0*y^1], ..., [x^0*y^(s_max-1)], [x^1*y^0], ...
        }
    }

    const gamma_a_inv=Fr.inv(tau.gamma_a);
    let xy_pows_t1g;
    let vk1_xy_pows_t1g = Array.from(Array(n-1), () => new Array(2*s_max-1));
    const t1_x=Fr.sub(await Fr.exp(x,n),Fr.one);
    const t1_x_g=Fr.mul(t1_x, gamma_a_inv);
    for(var i = 0; i < n-1; i++) {
        for(var j=0; j<2*s_max-1; j++){
            xy_pows_t1g= await Fr.mul(xy_pows[i][j], t1_x_g);
            vk1_xy_pows_t1g[i][j]= await G1.timesFr( buffG1, xy_pows_t1g );
            await zkeyUtils.writeG1( fdRS, curve, vk1_xy_pows_t1g[i][j] );
            // [x^0*y^0*t*g], [x^0*y^1*t*g], ..., [x^0*y^(s_max-1)*t*g], [x^1*y^0*t*g], ...
        }
    }

    let xy_pows_t2g;
    let vk1_xy_pows_t2g = Array.from(Array(n), () => new Array(s_max-1));
    const t2_y=Fr.sub(await Fr.exp(y,s_max),Fr.one);
    const t2_y_g=Fr.mul(t2_y, gamma_a_inv);
    for(var i = 0; i < n; i++) {
        for(var j=0; j<s_max-1; j++){
            xy_pows_t2g= await Fr.mul(xy_pows[i][j], t2_y_g);
            vk1_xy_pows_t2g[i][j]= await G1.timesFr( buffG1, xy_pows_t2g );
            await zkeyUtils.writeG1( fdRS, curve, vk1_xy_pows_t2g[i][j] );
            // [x^0*y^0*t*g], [x^0*y^1*t*g], ..., [x^0*y^(s_max-1)*t*g], [x^1*y^0*t*g], ...
        }
    }
    
    await endWriteSection(fdRS);
    // End of the sigma_G section
    ///////////

     // Write the sigma_H section
    ///////////
    await startWriteSection(fdRS, 4);
    let vk2_alpha_u;
    vk2_alpha_u = await G2.timesFr( buffG2, tau.alpha_u );
    let vk2_gamma_z;
    vk2_gamma_z = await G2.timesFr( buffG2, tau.gamma_z );
    let vk2_gamma_a;
    vk2_gamma_a = await G2.timesFr( buffG2, tau.gamma_a );
    await zkeyUtils.writeG2(fdRS, curve, vk2_alpha_u);
    await zkeyUtils.writeG2(fdRS, curve, vk2_gamma_z);
    await zkeyUtils.writeG2(fdRS, curve, vk2_gamma_a);

    let vk2_xy_pows
    for(var i = 0; i < n; i++) {
        for(var j=0; j<s_max; j++){
            vk2_xy_pows= await G2.timesFr( buffG2, xy_pows[i][j] );
            await zkeyUtils.writeG2(fdRS, curve, vk2_xy_pows );
            // [x^0*y^0], [x^0*y^1], ..., [x^0*y^(s_max-1)], [x^1*y^0], ...
        }
    }
    await endWriteSection(fdRS);
    // End of the sigma_H section
    ///////////

    // Test code 3// --> DONE
    // To test [x^i*y^j*t(x,y)/gamma_a]_G in sigma_G
    // with e(A,B) == e(C,D), where
    // A = [x^i*y^j]_G in sigma_G,
    // B = t(x,y)*H
    // C is the target,
    // D = [gamma_a]_H in sigma_H
    if(false){
        console.log(`Running Test 3`)
        let vk2_t_xy =  await G2.timesFr(buffG2, t_xy)
        for (let i = 0; i < n - 1; i++) {
			for (let j = 0; j < s_max - 1; j++) {
                let res = await curve.pairingEq(
                    vk1_xy_pows[i][j],
                    vk2_t_xy, 
                    vk1_xy_pows_tg[i][j],
                     await G2.neg(vk2_gamma_a))
				assert(res)
			}
		}
        console.log(`Test 3 finished`)
    }
    // End of the test code 3//

    // Write the theta_G[i] sections for i in [0, 1, ..., s_D] (alpha*u(X)+beta*v(X)+w(X))/gamma
    ///////////
    let Lagrange_basis = new Array(n);
    let term
    let acc
    let multiplier
    for(var i=0; i<n; i++){
        term=Fr.one;
        acc=Fr.one;
        multiplier=Fr.mul(await Fr.exp(Fr.inv(omega_x),i),x);
        for(var j=1; j<n; j++){
            term=Fr.mul(term,multiplier);
            acc=Fr.add(acc,term);
        }
        Lagrange_basis[i]=Fr.mul(Fr.inv(Fr.e(n)),acc);
    }
    // let temp = new Array(n)
    // for(var i=0; i<n; i++){
    //     temp[i] = Fr.toObject(Lagrange_basis[i])
    // }
    // console.log('Lags ', temp)

    for(var k = 0; k < s_D; k++){
        console.log(`k: ${k}`)
        let processResults_k
        processResults_k = await zkeyUtils.processConstraints(curve, nConstraints[k], sR1cs[k]); // to fill U, V, W
        let U = processResults_k.U
        let Uid = processResults_k.Uid
        let V = processResults_k.V
        let Vid = processResults_k.Vid
        let W = processResults_k.W
        let Wid = processResults_k.Wid
        console.log(`checkpoint7`)
    
        let ux = new Array(m[k]);
        let vx = new Array(m[k]);
        let wx = new Array(m[k]);
        for(var i=0; i<m[k]; i++){
            ux[i]=Fr.e(0);
            vx[i]=Fr.e(0);
            wx[i]=Fr.e(0);
        }
   
        let U_ids
        let U_coefs
        let V_ids
        let V_coefs
        let W_ids
        let W_coefs
        let Lagrange_term
        let U_idx
        let V_idx
        let W_idx
    
        for(var i=0; i<r1cs[k].nConstraints; i++){
            U_ids=Uid[i];
            U_coefs=U[i];
            V_ids=Vid[i];
            V_coefs=V[i];
            W_ids=Wid[i];
            W_coefs=W[i];
            for(var j=0; j<U_ids.length; j++){
                U_idx=U_ids[j]
                if(U_idx>=0){
                    Lagrange_term=Fr.mul(U_coefs[j],Lagrange_basis[i]);
                    ux[U_idx]=Fr.add(ux[U_idx],Lagrange_term);
                }
            }
            for(var j=0; j<V_ids.length; j++){
                V_idx=V_ids[j]
                if(V_idx>=0){
                    Lagrange_term=Fr.mul(V_coefs[j],Lagrange_basis[i]);
                    vx[V_idx]=Fr.add(vx[V_idx],Lagrange_term);
                }
            }
            for(var j=0; j<W_ids.length; j++){
                W_idx=W_ids[j]
                if(W_idx>=0){
                    Lagrange_term=Fr.mul(W_coefs[j],Lagrange_basis[i]);
                    wx[W_idx]=Fr.add(wx[W_idx],Lagrange_term);
                }
            }
        }
        console.log(`checkpoint8`)
    
        let vk1_ux = new Array(m[k])
        let vk1_vx = new Array(m[k])
        let vk2_vx = new Array(m[k])
        let vk1_zx = []
        let vk1_ax = []
        let combined_i
        let zx_i
        let ax_i
        
        for(var i=0; i<m[k]; i++){
            vk1_ux[i] = await G1.timesFr(buffG1, ux[i])
            vk1_vx[i] = await G1.timesFr(buffG1, vx[i])
            vk2_vx[i] = await G2.timesFr(buffG2, vx[i])
            combined_i = Fr.add(Fr.add(Fr.mul(tau.alpha_u, ux[i]), Fr.mul(tau.alpha_v, vx[i])), wx[i]);
            if(i>=NConstWires && i<NConstWires+mPublic[k]){
                zx_i=Fr.mul(combined_i, Fr.inv(tau.gamma_z));
                vk1_zx.push(await G1.timesFr(buffG1, zx_i))
            }
            else{
                ax_i=Fr.mul(combined_i, Fr.inv(tau.gamma_a));
                vk1_ax.push(await G1.timesFr(buffG1, ax_i))
            }
        }

        //console.log('temp test')
        //console.log('ux: ', ux)
        //console.log('vx: ', vx)
        //console.log('wx: ', wx)
        //console.log('temp test pass')
        // Test code 4//
        // To test [z^(k)_i(x)]_G and [a^(k)_i(x)]_G in sigma_G
        if(TESTFLAG){
            console.log(`Running Test 4`)
            let vk2_alpha_v = await G2.timesFr(buffG2, tau.alpha_v)
            let vk1_wx_i
            let res=0;
            for(var i=0; i<m[k]; i++){ // 모든 i 대신 랜덤한 몇 개의 i만 해봐도 good
                vk1_wx_i = await G1.timesFr(buffG1, wx[i])
                if(i>=NConstWires && i<NConstWires+mPublic[k]){
                    res = await curve.pairingEq(vk1_zx[i-NConstWires],  await G2.neg(vk2_gamma_z), 
                    vk1_ux[i], vk2_alpha_u,
                    vk1_vx[i], vk2_alpha_v,
                    vk1_wx_i, buffG2);
                }
                else{
                    res = await curve.pairingEq(vk1_ax[Math.max(0,i-mPublic[k])],  await G2.neg(vk2_gamma_a),
                    vk1_ux[i], vk2_alpha_u,
                    vk1_vx[i], vk2_alpha_v,
                    vk1_wx_i, buffG2)
/*                     if (k==6 && i==0){
                        console.log('k: ', k)
                        console.log('i: ', i)
                        console.log('i-mPublic: ', i-mPublic[k])
                        console.log('vk1_ax: ', vk1_ax)
                    } */
                    
                }
                if(res == false){
                    console.log('k: ', k)
                    console.log('i: ', i)
                }
                assert(res)
            }   
            console.log(`Test 4 finished`)
        }
        // End of the test code 4//

        await startWriteSection(fdRS, 5+k);
        console.log(`checkpoint9`)
        let multiplier
        let vk1_uxy_ij
        let vk1_vxy_ij
        let vk2_vxy_ij
        let vk1_zxy_ij
        let vk1_axy_ij
        for(var i=0; i < m[k]; i++){
            multiplier=Fr.inv(Fr.e(s_max))
            vk1_uxy_ij= await G1.timesFr(vk1_ux[i], multiplier)
            await zkeyUtils.writeG1(fdRS, curve, vk1_uxy_ij)
            for(var j=1; j < s_max; j++){
                multiplier=Fr.mul(multiplier, y)
                vk1_uxy_ij= await G1.timesFr(vk1_ux[i], multiplier)
                await zkeyUtils.writeG1(fdRS, curve, vk1_uxy_ij)
            }
        }
        for(var i=0; i < m[k]; i++){
            multiplier=Fr.inv(Fr.e(s_max))
            vk1_vxy_ij= await G1.timesFr(vk1_vx[i], multiplier)
            await zkeyUtils.writeG1(fdRS, curve, vk1_vxy_ij)
            for(var j=1; j < s_max; j++){
                multiplier=Fr.mul(multiplier, y)
                vk1_vxy_ij= await G1.timesFr(vk1_vx[i], multiplier)
                await zkeyUtils.writeG1(fdRS, curve, vk1_vxy_ij)
            }
        }
        for(var i=0; i < m[k]; i++){
            multiplier=Fr.inv(Fr.e(s_max))
            vk2_vxy_ij= await G2.timesFr(vk2_vx[i], multiplier)
            await zkeyUtils.writeG2(fdRS, curve, vk2_vxy_ij)
            for(var j=1; j < s_max; j++){
                multiplier=Fr.mul(multiplier, y)
                vk2_vxy_ij= await G2.timesFr(vk2_vx[i], multiplier)
                await zkeyUtils.writeG2(fdRS, curve, vk2_vxy_ij)
            }
        }
        console.log(`checkpoint10`)
        for(var i=0; i < mPublic[k]; i++){
            multiplier=Fr.inv(Fr.e(s_max))
            vk1_zxy_ij= await G1.timesFr(vk1_zx[i], multiplier)
            await zkeyUtils.writeG1(fdRS, curve, vk1_zxy_ij)
            for(var j=1; j < s_max; j++){
                multiplier=Fr.mul(multiplier, y)
                vk1_zxy_ij= await G1.timesFr(vk1_zx[i], multiplier)
                await zkeyUtils.writeG1(fdRS, curve, vk1_zxy_ij)
            }
        }
        for(var i=0; i < mPrivate[k]; i++){
            multiplier=Fr.inv(Fr.e(s_max))
            vk1_axy_ij= await G1.timesFr(vk1_ax[i], multiplier)
            await zkeyUtils.writeG1(fdRS, curve, vk1_axy_ij)
            for(var j=1; j < s_max; j++){
                multiplier=Fr.mul(multiplier, y)
                vk1_axy_ij= await G1.timesFr(vk1_ax[i], multiplier)
                await zkeyUtils.writeG1(fdRS, curve, vk1_axy_ij)
            }
        }
        await endWriteSection(fdRS)
        console.log(`checkpoint11`)
    }
        // Test code 5//
    
    if(TESTFLAG) // k==6 --> MOD subcircuit, c2 mod c3 = c1 <==> c4*c3+c1 = c2 <==> c4*c3 = -c1+c2
    {
        console.log('Running Test 5')
        let res = [];
        res.push(await curve.pairingEq(vk1_xy_pows_t1g[1][1], vk2_gamma_a,
            await G1.timesFr(buffG1, Fr.mul(x,y)), await G2.neg(await G2.timesFr(buffG2, t1_x))
            )
        );
        console.log(res)
        
        if (!res[0]){
            throw new Error('Test 5 failed')
        }
        console.log(`Test 5 finished`)
    }
    // End of the test code 5//
    

    await fdRS.close()
    console.log(`checkpoint12`)

    const totalTime = timer.end(startTime);
    console.log(`###Total ellapsed time: ${totalTime} [ms]`)

    // End of the theta_G section
    ///////////
/* 
    // TEST CODE 6
    if (TESTFLAG == true){
        console.log(`Running Test 1`)
        
        const sR1cs = new Array(); 
        for(var i=0; i<s_D; i++){
            let r1csIdx = String(i);
            const {fd: fdR1cs, sections: sectionsR1cs} = await readBinFile('resource/subcircuits/r1cs/subcircuit'+r1csIdx+'.r1cs', "r1cs", 1, 1<<22, 1<<24);
            sR1cs.push(await readSection(fdR1cs, sectionsR1cs, 2));
            await fdR1cs.close();
        }

        const {uX_ki: uX_ki, vX_ki: vX_ki, wX_ki: wX_ki, tXY: tXY} = await polyUtils.buildR1csPolys(urs.param, sR1cs);
        let fY = Array.from(Array(1), () => new Array(s_max));
        const Fr_s_max_inv = Fr.inv(Fr.e(s_max));
        fY = await polyUtils.scalePoly(Fr, fY, Fr_s_max_inv);

        
        let XY_pows = Array.from(Array(n-1), () => new Array(s_max-1));
        XY_pows = await polyUtils.scalePoly(Fr, XY_pows, Fr.one);
        const XY_pows_tXY = await polyUtils.mulPoly(Fr, tXY, XY_pows);

        const test_xy_pows_t = await polyUtils.evalPoly(Fr, XY_pows_tXY, x, y);


        



        



        console.log(U_ids[0])
        const test_ux = await polyUtils.evalPoly(Fr, uX_ki[k][U_ids[0]], x, Fr.one);
        console.log(`test: ${Fr.toObject(test_ux)}`)
        console.log(`target: ${Fr.toObject(ux[U_ids[0]])}`)
        if (!Fr.eq(test_ux, ux[U_ids[0]])){
            throw new Error(`Polynomial evaluation failed`)
        }
        
        console.log(`Test 1 finished`)
    }
    // END OF TEST CODE 6
 */
    


    function createTauKey(Field, rng) {
        if (rng.length != 6){
            console.log(`checkpoint3`)
            throw new Error('It should have six elements.')
        } 
        const key = {
            x: Field.fromRng(rng[0]),
            y: Field.fromRng(rng[1]),
            alpha_u: Field.fromRng(rng[2]),
            alpha_v: Field.fromRng(rng[3]),
            gamma_a: Field.fromRng(rng[4]),
            gamma_z: Field.fromRng(rng[5])
        }
        return key
    }

}

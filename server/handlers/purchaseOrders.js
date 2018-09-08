const db = require('../models');

function groupBy(objectArray, property) {
 return objectArray.reduce(function (acc, obj) {
   var key = obj[property];
   if (!acc[key]) {
     acc[key] = [];
   }
   acc[key].push(obj);
   return acc;
 }, {});
}

const updateMath = (current, update, type) => {
  return type === 'outbound' ? parseInt(current - update) : parseInt(current + update)
}

exports.processPurchaseOrderImport = async (req, res, next) => {
	try {
    let addedPOs = [];
    let addedProducts = [];
    let poData = req.body.json.map((po,i)=>({
      ...po,
      name: po['po name'],
      type: po['po type'],
      isComplete: po['po status'] === 'complete' || po['po status'] === undefined  ? true : false,
      sku: po['sku'],
      quantity: po['quantity'],
      company: req.body.company,
      skuCompany: `${po['sku']}-${req.body.company}`,
      poRef: `${req.body.company}-${po['po name']}-${po['po type']}-${po['po status'] === 'complete' ? true : false}-${Date.now()}`,
    }))
    // group the po's by their unique ref, combined "-" seperate string of company name, po name, po type, po status, current date obj
    let groupedPOs = groupBy(poData, 'poRef');
    // loop each po by it's unique ref to create it
    for (let ref of Object.keys(groupedPOs)) {
      // create the main po from the first array item for the matching poRef
      let mainPO = await db.PurchaseOrder.create({
        name: groupedPOs[ref][0].name,
        type: groupedPOs[ref][0].type,
        isComplete: groupedPOs[ref][0].isComplete,
        poRef: groupedPOs[ref][0].poRef,
        company: groupedPOs[ref][0].company,
      })
      addedPOs.push(mainPO)
      // loop the array for each po ref and create the poProducts
      let poProducts = groupedPOs[ref].map(poLine => ({
				updateOne: {
					filter: { skuCompany: poLine.skuCompany, poRef: poLine.poRef},
					update: {...poLine},
					upsert: true,
				}
			}))
			let addedPoProducts = await db.PoProduct.bulkWrite(poProducts)
      // update quantities in main products table if PO was marked complete on import
      if (mainPO.isComplete) {
        // find all company products
        let companyProducts = await db.Product.find({company: req.body.company})
        // loop over all products and create array of updates to bulk write
        let productUpdates = groupedPOs[ref].map(poLine => {
          // find the related product and update interval
          let foundProduct = companyProducts.find(product => product.skuCompany === poLine.skuCompany)
          if (foundProduct) {
            console.log('found product qty is')
            console.log(foundProduct.quantity + poLine.quantity + poLine.type)
            return {
              updateOne: {
                filter: { skuCompany: `${poLine.sku}-${req.body.company}`},
                update: { quantity: updateMath(foundProduct.quantity, poLine.quantity, poLine.type) },
              }
            }
          } else {
            // otherwise insert it with inital qty of 0
            console.log('inserting product')
            return {
              insertOne: {
                document: {
                  sku: poLine.sku,
                  skuCompany: poLine.skuCompany,
                  company: poLine.company,
                  quantity: updateMath(0, poLine.quantity, poLine.type),
                }
              }
            }
          }
        })
        let updatedProducts = await db.Product.bulkWrite(productUpdates)
        addedProducts.push(updatedProducts)
      }
    }
    return res.status(200).json({addedPOs, addedProducts})
	} catch(err) {
		return next(err);
	}
}
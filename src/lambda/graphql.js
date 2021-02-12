const { ApolloServer } = require("apollo-server-lambda");
const neo4j = require("neo4j-driver");
const { makeAugmentedSchema } = require("neo4j-graphql-js");
const jwt = require("jsonwebtoken");
const jwks = require("jwks-rsa")

const client = jwks({jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`})

const getPublicKey = (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
        const publicKey = key.publicKey || key.rsaPublicKey;
        callback(null, publicKey)
    })
}

const resolvers = {
  Business: {
    waitTime: (obj, args, context, info) => {
      var options = [0, 5, 10, 15, 30, 45];
      return options[Math.floor(Math.random() * options.length)];
    },
  },
};

const typeDefs = /* GraphQL */ `
  type Query {
    fuzzyBusinessByName(searchString: String): [Business]
      @cypher(
        statement: """
        CALL db.index.fulltext.queryNodes( 'businessNameIndex', $searchString+'~')
        YIELD node RETURN node
        """
      )
  }

  input CreateReviewInput {
    stars: Float!
    businessId: ID!
    text: String
  }

  type Mutation {
    createReviewForCurrentUser(review: CreateReviewInput): Review
      @cypher(
        statement: """
        MERGE (u:User {userId: $cypherParams.userId})
        MERGE (b:Business {businessId: $review.businessId})
        CREATE (r:Review)
        SET r.reviewId = randomUUID(),
            r.stars    = $review.reviewId,
            r.text     = coalesce($review.text, ''),
            r.date     = date()
        CREATE (u)-[:WROTE]->(r)
        CREATE (r)-[:REVIEWS]->(b)
        RETURN r
        """
      )
  }

  type Business {
    businessId: ID!
    waitTime: Int! @neo4j_ignore
    averageStars: Float!
      @cypher(
        statement: "MATCH (this)<-[:REVIEWS]-(r:Review) RETURN avg(r.stars)"
      )
    recommended(first: Int = 1): [Business]
      @cypher(
        statement: """
        MATCH (this)<-[:REVIEWS]-(:Review)<-[:WROTE]-(:User)-[:WROTE]->(:Review)-[:REVIEWS]->(rec:Business)
        WITH rec, COUNT(*) AS score
        RETURN rec ORDER BY score DESC LIMIT $first
        """
      )
    name: String!
    city: String!
    state: String!
    address: String!
    location: Point!
    reviews: [Review] @relation(name: "REVIEWS", direction: IN)
    categories: [Category] @relation(name: "IN_CATEGORY", direction: OUT)
  }

  type User {
    userID: ID!
    name: String!
    reviews: [Review] @relation(name: "WROTE", direction: OUT)
  }

  type Review {
    reviewId: ID!
    stars: Float!
    date: Date!
    text: String
    user: User @relation(name: "WROTE", direction: IN)
    business: Business @relation(name: "REVIEWS", direction: OUT)
  }

  type Category {
    name: String!
    businesses: [Business] @relation(name: "IN_CATEGORY", direction: IN)
  }
`;

const schema = makeAugmentedSchema({
  typeDefs,
  resolvers,
  config: {
    mutation: false,
  },
});

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

const server = new ApolloServer({
  schema,
  context: async ({ event }) => {
    const token = event.headers?.authorization?.slice(7);
    let userId;

    if (!token) {
        return {
            driver
        }
    }

    const authResult = new Promise((resolve, reject) => {
        jwt.verify(
            token,
            getPublicKey, {
                algorithms: ["RS256"]
            },
            (error, decoded) => {
                if (error) {
                    reject({error})
                }
                if (decoded) {
                    resolve(decoded)
                }
            }
        )
    })

    const decoded = await authResult;

    
    return {
      driver,
      req: event,
      cypherParams: {
        userId: decoded.sub,
      },
    };
  },
  introspection: true,
  playground: true,
});

exports.handler = server.createHandler();

import {
  Matrix,
  MatrixTransposeView,
  EVD,
  SVD,
  NIPALS,
  AbstractMatrix,
} from 'ml-matrix';

type MaybeMatrix = AbstractMatrix | number[][];

/**
 * Creates new PCA (Principal Component Analysis) from the dataset
 * @param {Matrix} dataset - dataset or covariance matrix.
 * @param {Object} [options]
 * @param {boolean} [options.isCovarianceMatrix=false] - true if the dataset is a covariance matrix.
 * @param {string} [options.method='SVD'] - select which method to use: SVD (default), covarianceMatrirx or NIPALS.
 * @param {number} [options.nCompNIPALS=2] - number of components to be computed with NIPALS.
 * @param {boolean} [options.center=true] - should the data be centered (subtract the mean).
 * @param {boolean} [options.scale=false] - should the data be scaled (divide by the standard deviation).
 * @param {boolean} [options.ignoreZeroVariance=false] - ignore columns with zero variance if `scale` is `true`.
 * */
export class PCA {
  private center: boolean;
  private scale: boolean;
  private excludedFeatures: number[];
  /* eslint-disable @typescript-eslint/naming-convention */
  private U: Matrix | null = null;
  private S: number[] | null = null;
  private R: any;
  private means: number[] | null;
  private stdevs: number[] | null;

  public constructor(
    dataset?: MaybeMatrix,
    options: {
      isCovarianceMatrix?: boolean;
      method?: string;
      nCompNIPALS?: number;
      center?: boolean;
      scale?: boolean;
      ignoreZeroVariance?: boolean;
    } = {},
    model?,
  ) {
    if (model) {
      this.center = model.center;
      this.scale = model.scale;
      this.means = model.means;
      this.stdevs = model.stdevs;
      this.U = Matrix.checkMatrix(model.U);
      this.S = model.S;
      this.R = model.R;
      this.excludedFeatures = model.excludedFeatures || [];
      return;
    }
    let datasetMatrix: Matrix;
    if (Array.isArray(dataset)) {
      datasetMatrix = new Matrix(dataset);
    } else {
      datasetMatrix = new Matrix(dataset as Matrix);
    }

    const {
      isCovarianceMatrix = false,
      method = 'SVD',
      nCompNIPALS = 2,
      center = true,
      scale = false,
      ignoreZeroVariance = false,
    } = options;

    this.center = center;
    this.scale = scale;
    this.means = null;
    this.stdevs = null;
    this.excludedFeatures = [];

    if (isCovarianceMatrix) {
      // User provided a covariance matrix instead of dataset.
      this._computeFromCovarianceMatrix(datasetMatrix);
      return;
    }

    this._adjust(datasetMatrix, ignoreZeroVariance);
    switch (method) {
      case 'covarianceMatrix': {
        // User provided a dataset but wants us to compute and use the covariance matrix.
        const covarianceMatrix = new MatrixTransposeView(datasetMatrix)
          .mmul(datasetMatrix)
          .div(datasetMatrix.rows - 1);
        this._computeFromCovarianceMatrix(covarianceMatrix);
        break;
      }
      case 'NIPALS': {
        this._computeWithNIPALS(datasetMatrix, nCompNIPALS);
        break;
      }
      case 'SVD': {
        const svd = new SVD(datasetMatrix, {
          computeLeftSingularVectors: false,
          computeRightSingularVectors: true,
          autoTranspose: true,
        });

        this.U = svd.rightSingularVectors;

        const singularValues = svd.diagonal;
        const eigenvalues: Array<number> = [];
        for (const singularValue of singularValues) {
          eigenvalues.push(
            (singularValue * singularValue) / (datasetMatrix.rows - 1),
          );
        }
        this.S = eigenvalues;
        break;
      }
      default: {
        throw new Error(`unknown method: ${method}`);
      }
    }
  }

  /**
   * Load a PCA model from JSON
   * @param {Object} model
   * @return {PCA}
   */
  public static load(model: any): PCA {
    if (typeof model.name !== 'string') {
      throw new TypeError('model must have a name property');
    }
    if (model.name !== 'PCA') {
      throw new RangeError(`invalid model: ${model.name}`);
    }
    return new PCA(undefined, undefined, model);
  }

  /**
   * Project the dataset into the PCA space
   * @param {Matrix} dataset
   * @param {Object} options
   * @return {Matrix} dataset projected in the PCA space
   */
  public predict(
    dataset: MaybeMatrix,
    options: { nComponents?: number } = {},
  ): Matrix {
    const { nComponents = (this.U as Matrix).columns } = options;
    let datasetmatrix;
    if (Array.isArray(dataset)) {
      datasetmatrix = new Matrix(dataset);
    } else {
      datasetmatrix = new Matrix(dataset);
    }
    if (this.center) {
      datasetmatrix.subRowVector(this.means as number[]);
      if (this.scale) {
        for (let i of this.excludedFeatures) {
          datasetmatrix.removeColumn(i);
        }
        datasetmatrix.divRowVector(this.stdevs as number[]);
      }
    }
    let predictions = datasetmatrix.mmul(this.U as Matrix);
    return predictions.subMatrix(0, predictions.rows - 1, 0, nComponents - 1);
  }

  /**
   * Calculates the inverse PCA transform
   * @param {Matrix} dataset
   * @return {Matrix} dataset projected in the PCA space
   */
  public invert(dataset: Matrix): Matrix {
    dataset = Matrix.checkMatrix(dataset);

    let inverse = dataset.mmul((this.U as Matrix).transpose());

    if (this.center) {
      if (this.scale) {
        inverse.mulRowVector(this.stdevs as number[]);
      }
      inverse.addRowVector(this.means as number[]);
    }

    return inverse;
  }

  /**
   * Returns the proportion of variance for each component
   * @return {[number]}
   */
  public getExplainedVariance(): number[] {
    let sum = 0;
    if (this.S) {
      for (const s of this.S) {
        sum += s;
      }
    }
    return this.S?.map((value) => value / sum) as number[];
  }

  /**
   * Returns the cumulative proportion of variance
   * @return {[number]}
   */
  public getCumulativeVariance(): number[] {
    let explained = this.getExplainedVariance();
    for (let i = 1; i < explained.length; i++) {
      explained[i] += explained[i - 1];
    }
    return explained;
  }

  /**
   * Returns the Eigenvectors of the covariance matrix
   * @returns {Matrix}
   */
  public getEigenvectors(): Matrix {
    return this.U as Matrix;
  }

  /**
   * Returns the Eigenvalues (on the diagonal)
   * @returns {[number]}
   */
  public getEigenvalues(): number[] {
    return this.S as number[];
  }

  /**
   * Returns the standard deviations of the principal components
   * @returns {[number]}
   */
  public getStandardDeviations(): number[] {
    return (this.S as number[]).map((x) => Math.sqrt(x));
  }

  /**
   * Returns the loadings matrix
   * @return {Matrix}
   */
  public getLoadings(): Matrix {
    return (this.U as Matrix).transpose();
  }

  /**
   * Export the current model to a JSON object
   * @return {Object} model
   */
  public toJSON() {
    return {
      name: 'PCA',
      center: this.center,
      scale: this.scale,
      means: this.means,
      stdevs: this.stdevs,
      U: this.U,
      S: this.S,
      excludedFeatures: this.excludedFeatures,
    };
  }

  private _adjust(dataset: Matrix, ignoreZeroVariance: boolean) {
    if (this.center) {
      const mean = dataset.mean('column');
      const stdevs = this.scale
        ? dataset.standardDeviation('column', { mean })
        : null;
      this.means = mean;
      dataset.subRowVector(mean);
      if (this.scale) {
        for (let i = 0; i < (stdevs as number[]).length; i++) {
          if ((stdevs as number[])[i] === 0) {
            if (ignoreZeroVariance) {
              dataset.removeColumn(i);
              (stdevs as number[]).splice(i, 1);
              this.excludedFeatures.push(i);
              i--;
            } else {
              throw new RangeError(
                `Cannot scale the dataset (standard deviation is zero at index ${i}`,
              );
            }
          }
        }
        this.stdevs = stdevs;
        dataset.divRowVector(stdevs as number[]);
      }
    }
  }

  private _computeFromCovarianceMatrix(dataset: MaybeMatrix) {
    const evd = new EVD(dataset as number[][], { assumeSymmetric: true });
    this.U = evd.eigenvectorMatrix;
    this.U.flipRows();
    this.S = evd.realEigenvalues;
    this.S.reverse();
  }

  private _computeWithNIPALS(dataset: Matrix, nCompNIPALS: number) {
    this.U = new Matrix(nCompNIPALS, dataset.columns);
    this.S = [];

    let x = dataset;
    for (let i = 0; i < nCompNIPALS; i++) {
      let dc = new NIPALS(x);

      this.U.setRow(i, dc.w.transpose());
      this.S.push(Math.pow(dc.s.get(0, 0), 2));

      x = dc.xResidual;
    }
    this.U = this.U.transpose(); // to be compatible with API
  }
}
